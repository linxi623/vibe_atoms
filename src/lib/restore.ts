import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { reapStaleTasks } from "@/lib/generation";

export async function restoreVersion(owner: string, projectId: string, targetId: string, key: string) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const project = await client.query(
      "SELECT current_version_id FROM projects WHERE id = $1 AND visitor_id = $2 FOR UPDATE",
      [projectId, owner],
    );
    if (!project.rows[0]) {
      await client.query("ROLLBACK");
      return { kind: "not_found" as const };
    }
    const existing = await client.query(
      `SELECT id, restored_from_id FROM versions
       WHERE project_id = $1 AND restore_idempotency_key = $2`,
      [projectId, key],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return existing.rows[0].restored_from_id === targetId
        ? { kind: "existing" as const, versionId: existing.rows[0].id }
        : { kind: "conflict" as const };
    }
    await reapStaleTasks(client, projectId);
    const active = await client.query(
      "SELECT 1 FROM tasks WHERE project_id = $1 AND status = 'running'",
      [projectId],
    );
    if (active.rows[0]) {
      await client.query("ROLLBACK");
      return { kind: "conflict" as const };
    }
    const target = await client.query<{ html: string; sequence: number }>(
      "SELECT html, sequence FROM versions WHERE id = $1 AND project_id = $2",
      [targetId, projectId],
    );
    if (!target.rows[0]) {
      await client.query("ROLLBACK");
      return { kind: "version_not_found" as const };
    }
    const sequence = await client.query<{ next: number }>(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM versions WHERE project_id = $1",
      [projectId],
    );
    const versionId = randomUUID();
    await client.query(
      `INSERT INTO versions(id, project_id, sequence, html, summary, restored_from_id, restore_idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [versionId, projectId, sequence.rows[0].next, target.rows[0].html,
        `恢复自 v${target.rows[0].sequence}`, targetId, key],
    );
    await client.query(
      "UPDATE projects SET current_version_id = $1, updated_at = now() WHERE id = $2",
      [versionId, projectId],
    );
    await client.query("COMMIT");
    return { kind: "created" as const, versionId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
