import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { db } from "@/lib/db";
import { generateApplication, ModelError } from "@/lib/model";

export type TaskErrorCode = "MODEL" | "FORMAT" | "STORAGE" | "NETWORK" | "CONFLICT" | "TIMEOUT";

function errorCode(error: unknown): TaskErrorCode {
  if (error instanceof ModelError) {
    if (error.code === "MODEL_FORMAT") return "FORMAT";
    if (error.code === "MODEL_TIMEOUT") return "TIMEOUT";
    if (error.code === "MODEL_NETWORK") return "NETWORK";
    return "MODEL";
  }
  return "STORAGE";
}

function errorMessage(error: unknown): string {
  if (error instanceof ModelError) return error.message;
  return "保存生成结果失败";
}

function retryable(error: unknown): boolean {
  return !(error instanceof ModelError && error.code === "MODEL_CONFIG");
}

export function validatePrompt(prompt: unknown): string {
  if (typeof prompt !== "string") throw new Error("需求文本不能为空");
  const value = prompt.trim();
  if (!value || value.length > 8_000) throw new Error("需求文本必须为 1-8000 个字符");
  return value;
}

const taskTimeoutMs = 180_000;
const promptHash = (prompt: string, retryOfId?: string) =>
  createHash("sha256").update(JSON.stringify([prompt, retryOfId ?? null])).digest("hex");

export async function reapStaleTasks(client: pg.PoolClient | pg.Pool, projectId?: string) {
  await client.query(
    `UPDATE tasks SET status = 'failed', stage = 'done', error_code = 'TIMEOUT',
            error_detail = '生成任务超时或中断', updated_at = now()
     WHERE status = 'running' AND COALESCE(deadline_at, created_at + interval '3 minutes') < now()
       AND ($1::uuid IS NULL OR project_id = $1)`,
    [projectId ?? null],
  );
}

export async function createTask(owner: string, projectId: string, prompt: string, idempotencyKey: string, retryOfId?: string) {
  const pool = db();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const project = await client.query<{ current_version_id: string | null }>(
      "SELECT current_version_id FROM projects WHERE id = $1 AND visitor_id = $2 FOR UPDATE",
      [projectId, owner],
    );
    if (!project.rows[0]) {
      await client.query("ROLLBACK");
      return { kind: "not_found" as const };
    }
    await reapStaleTasks(client, projectId);
    const existing = await client.query(
      `SELECT t.id, t.project_id AS "projectId", t.status, t.stage,
              t.error_code AS "errorCode", t.retry_of_id AS "retryOfId", t.prompt_hash AS "promptHash"
       FROM tasks t
       WHERE t.project_id = $1 AND t.idempotency_key = $2`,
      [projectId, idempotencyKey],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      if (existing.rows[0].promptHash !== promptHash(prompt, retryOfId)) {
        return { kind: "conflict" as const };
      }
      return { kind: "existing" as const, task: existing.rows[0] };
    }
    if (retryOfId) {
      const prior = await client.query(
        "SELECT status FROM tasks WHERE id = $1 AND project_id = $2",
        [retryOfId, projectId],
      );
      if (prior.rows[0]?.status !== "failed") {
        await client.query("ROLLBACK");
        return { kind: "invalid_retry" as const };
      }
    }
    const active = await client.query("SELECT id FROM tasks WHERE project_id = $1 AND status = 'running'", [projectId]);
    if (active.rows[0]) {
      await client.query("ROLLBACK");
      return { kind: "conflict" as const };
    }
    const taskId = randomUUID();
    await client.query(
      `INSERT INTO tasks(id, project_id, base_version_id, status, stage, idempotency_key, retry_of_id, prompt_hash, deadline_at)
       VALUES ($1, $2, $3, 'running', 'planning', $4, $5, $6, now() + interval '3 minutes')`,
      [taskId, projectId, project.rows[0].current_version_id, idempotencyKey, retryOfId ?? null, promptHash(prompt, retryOfId)],
    );
    await client.query(
      "INSERT INTO messages(id, project_id, role, content, task_id) VALUES ($1, $2, 'user', $3, $4)",
      [randomUUID(), projectId, prompt, taskId],
    );
    await client.query("COMMIT");
    return { kind: "created" as const, taskId, baseVersionId: project.rows[0].current_version_id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function executeTask(taskId: string, prompt: string, baseVersionId: string | null) {
  const pool = db();
  const deadline = Date.now() + taskTimeoutMs;
  try {
    let currentHtml: string | null = null;
    if (baseVersionId) {
      const base = await pool.query<{ html: string }>("SELECT html FROM versions WHERE id = $1", [baseVersionId]);
      currentHtml = base.rows[0]?.html ?? null;
    }
    const result = await generateApplication(prompt, currentHtml, deadline, async (plan) => {
      await pool.query(
        "UPDATE tasks SET stage = 'generating', plan = $2, updated_at = now() WHERE id = $1 AND status = 'running'",
        [taskId, JSON.stringify(plan)],
      );
    }, async () => {
      await pool.query("UPDATE tasks SET stage = 'checking', updated_at = now() WHERE id = $1 AND status = 'running'", [taskId]);
    }, staticCheck);
    const html = result.html;
    await pool.query("UPDATE tasks SET stage = 'saving', updated_at = now() WHERE id = $1 AND status = 'running'", [taskId]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const projectId = await client.query<{ project_id: string }>("SELECT project_id FROM tasks WHERE id = $1", [taskId]);
      if (!projectId.rows[0]) throw new ModelError("生成任务不存在", "MODEL_PROVIDER");
      const lockedProject = await client.query(
        "SELECT current_version_id FROM projects WHERE id = $1 FOR UPDATE",
        [projectId.rows[0].project_id],
      );
      const task = await client.query<{ project_id: string; base_version_id: string | null }>(
        "SELECT project_id, base_version_id FROM tasks WHERE id = $1 AND status = 'running' AND deadline_at > now() FOR UPDATE",
        [taskId],
      );
      if (!task.rows[0]) throw new ModelError("生成任务超时", "MODEL_TIMEOUT");
      if (lockedProject.rows[0]?.current_version_id !== task.rows[0].base_version_id) {
        throw new ModelError("基线版本已变化", "MODEL_PROVIDER");
      }
      const sequence = await client.query<{ next: number }>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM versions WHERE project_id = $1",
        [task.rows[0].project_id],
      );
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO versions(id, project_id, sequence, html, summary, task_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [versionId, task.rows[0].project_id, sequence.rows[0].next, html, result.summary, taskId],
      );
      await client.query(
        `UPDATE projects SET current_version_id = $1, updated_at = now() WHERE id = $2`,
        [versionId, task.rows[0].project_id],
      );
      await client.query(
        `INSERT INTO messages(id, project_id, role, content, task_id) VALUES ($1, $2, 'assistant', $3, $4)`,
        [randomUUID(), task.rows[0].project_id, result.plan.summary, taskId],
      );
      await client.query("UPDATE tasks SET status = 'succeeded', stage = 'done', updated_at = now() WHERE id = $1", [taskId]);
      await client.query("COMMIT");
      return { versionId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const code = errorCode(error);
    await pool.query(
      "UPDATE tasks SET status = 'failed', stage = 'done', error_code = $2, error_detail = $3, updated_at = now() WHERE id = $1 AND status = 'running'",
      [taskId, code, errorMessage(error)],
    ).catch(() => undefined);
    return { error: errorMessage(error), errorCode: code, retryable: retryable(error) };
  }
}

export function staticCheck(html: string): void {
  const invalid = (message: string): never => { throw new ModelError(message, "MODEL_FORMAT"); };
  if (!/^\s*<!doctype html>/i.test(html) || !/<html[\s>]/i.test(html) || !/<head[\s>]/i.test(html) ||
      !/<body[\s>]/i.test(html) || !/<\/html\s*>\s*$/i.test(html) ||
      !/<script[\s>]/i.test(html) || Buffer.byteLength(html) > 500_000) {
    invalid("必须是完整且不超过 500KB 的单文件 HTML");
  }
  if (/<(?:iframe|frame|object|embed|base|form)\b|<meta\b[^>]*http-equiv\s*=/i.test(html)) invalid("禁止嵌入、表单或文档跳转");
  if (/<[a-z][^>]*\s(?:on[a-z]+|src|srcset|href|action|formaction|poster|background|ping)\s*=/i.test(html)) invalid("禁止资源、导航或内联事件属性");
  if (/@import\b|url\s*\(|https?:|wss?:|ftp:|javascript:|data:|\/\/[a-z0-9]/i.test(html)) invalid("禁止外部 URL 或 CSS 资源");
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker|importScripts)\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker|Function)\s*\(|\beval\s*\(|\bimport\s*\(/i.test(html)) invalid("禁止网络或动态执行");
  if (/\b(?:window|globalThis|self)\s*\.\s*(?:top|parent|opener|location|localStorage|sessionStorage|indexedDB|open)\b|\bdocument\s*\.\s*(?:cookie|location)\b|\bnavigator\s*\.\s*sendBeacon\b/i.test(html)) invalid("禁止平台访问或存储");
}
