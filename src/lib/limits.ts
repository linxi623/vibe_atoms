import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import type pg from "pg";
import { db } from "@/lib/db";

export class LimitError extends Error {
  constructor(public readonly status: 429 | 503, message: string) {
    super(message);
  }
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LimitError(503, "Service limits are not configured");
  }
  return value;
}

export function limits() {
  return {
    sessionPerHour: positiveInt("LIMIT_SESSION_PER_HOUR", 20),
    writePerMinute: positiveInt("LIMIT_WRITE_PER_MINUTE", 120),
    ipWritePerMinute: positiveInt("LIMIT_IP_WRITE_PER_MINUTE", 180),
    generationPerSessionHour: positiveInt("LIMIT_GENERATION_PER_SESSION_HOUR", 20),
    generationPerSessionDay: positiveInt("LIMIT_GENERATION_PER_SESSION_DAY", 50),
    generationPerIpHour: positiveInt("LIMIT_GENERATION_PER_IP_HOUR", 40),
    generationPerIpDay: positiveInt("LIMIT_GENERATION_PER_IP_DAY", 100),
    generationPerProjectHour: positiveInt("LIMIT_GENERATION_PER_PROJECT_HOUR", 25),
    globalConcurrency: positiveInt("LIMIT_GLOBAL_CONCURRENCY", 2),
    totalTasks: positiveInt("LIMIT_TOTAL_TASKS", 200),
    taskTimeoutMs: positiveInt("TASK_TIMEOUT_MS", 180_000),
  };
}

export function clientIpKey(request: NextRequest): string {
  // Only use proxy-provided addresses when a trusted ingress strips incoming forwarding headers.
  let address = "unidentified";
  if (process.env.TRUST_PROXY_IP === "true") {
    const secret = process.env.IP_HASH_SECRET;
    if (!secret || secret.length < 16) {
      throw new LimitError(503, "Service limits are not configured");
    }
    const candidate = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
    if (isIP(candidate)) address = candidate;
    return createHmac("sha256", secret).update(address).digest("hex");
  }
  return address;
}

type Reservation = [scope: "ip" | "session" | "project", key: string, window: "minute" | "hour" | "day", limit: number];

async function reserve(client: pg.PoolClient, action: string, entries: Reservation[]): Promise<void> {
  if (Math.random() < 0.01) {
    await client.query("DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '2 days'");
  }
  for (const [scope, key, window, limit] of entries) {
    const result = await client.query<{ count: number }>(
      `INSERT INTO rate_limit_buckets(action, scope, key, window_start, count)
       VALUES ($1, $2, $3, date_trunc($4, now()), 1)
       ON CONFLICT (action, scope, key, window_start)
       DO UPDATE SET count = rate_limit_buckets.count + 1
       RETURNING count`,
      [action, scope, key, window],
    );
    if (result.rows[0].count > limit) throw new LimitError(429, "Too many requests");
  }
}

export async function reserveSession(client: pg.PoolClient, ip: string): Promise<void> {
  await reserve(client, "session", [["ip", ip, "hour", limits().sessionPerHour]]);
}

export async function reserveGeneration(client: pg.PoolClient, owner: string, ip: string, project: string): Promise<void> {
  const setting = limits();
  await reserve(client, "generation", [
    ["session", owner, "hour", setting.generationPerSessionHour],
    ["session", owner, "day", setting.generationPerSessionDay],
    ["ip", ip, "hour", setting.generationPerIpHour],
    ["ip", ip, "day", setting.generationPerIpDay],
    ["project", project, "hour", setting.generationPerProjectHour],
  ]);
}

export async function reserveWrite(owner: string, ip: string): Promise<void> {
  const setting = limits();
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await reserve(client, "write", [
      ["session", owner, "minute", setting.writePerMinute],
      ["ip", ip, "minute", setting.ipWritePerMinute],
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reserveTaskBudget(client: pg.PoolClient): Promise<void> {
  const result = await client.query<{ count: number }>(
    `INSERT INTO platform_counters(name, count) VALUES ('generation_tasks', 1)
     ON CONFLICT (name) DO UPDATE SET count = platform_counters.count + 1
     RETURNING count`,
  );
  if (result.rows[0].count > limits().totalTasks) {
    throw new LimitError(429, "Generation budget exhausted");
  }
}
