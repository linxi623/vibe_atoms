import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type pg from "pg";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { clientIpKey, reserveAuth } from "@/lib/limits";
import { digest, sessionAge, sessionToken } from "@/lib/session";

const scrypt = promisify(scryptCallback);
const dummyHash = `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`;

export function credentials(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== "object") return null;
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ||
      password.length < 12 || password.length > 128) return null;
  return { email: normalized, password };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, Buffer.from(salt, "hex"), 64) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split(":");
  const derived = await scrypt(password, Buffer.from(salt, "hex"), 64) as Buffer;
  return timingSafeEqual(derived, Buffer.from(hash, "hex"));
}

export async function throttleAuth(request: NextRequest, email: string): Promise<void> {
  const key = createHash("sha256").update(email).digest("hex");
  await reserveAuth(clientIpKey(request), key);
}

export async function guestId(client: pg.PoolClient, request: NextRequest): Promise<string | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const result = await client.query<{ id: string }>(
    "SELECT id FROM visitors WHERE token_hash = $1 FOR UPDATE", [digest(token)],
  );
  return result.rows[0]?.id ?? null;
}

export async function revokeGuest(client: pg.PoolClient, id: string): Promise<void> {
  await client.query("UPDATE visitors SET token_hash = $2 WHERE id = $1", [id, digest(randomBytes(32).toString("hex"))]);
}

export async function issueAccountSession(client: pg.PoolClient, userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await client.query(
    "INSERT INTO account_sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')",
    [digest(token), userId],
  );
  return token;
}

export async function register(request: NextRequest, email: string, password: string) {
  const passwordHash = await hashPassword(password);
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const guest = await guestId(client, request);
    const owner = guest ?? randomUUID();
    if (!guest) await client.query("INSERT INTO visitors(id, token_hash) VALUES ($1, $2)", [
      owner, digest(randomBytes(32).toString("hex")),
    ]);
    const userId = randomUUID();
    await client.query(
      "INSERT INTO users(id, email, password_hash, owner_visitor_id) VALUES ($1, $2, $3, $4)",
      [userId, email, passwordHash, owner],
    );
    const token = await issueAccountSession(client, userId);
    if (guest) await revokeGuest(client, guest);
    await client.query("COMMIT");
    return token;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function login(request: NextRequest, email: string, password: string): Promise<string | null> {
  const found = await db().query<{ id: string; password_hash: string; owner_visitor_id: string }>(
    "SELECT id, password_hash, owner_visitor_id FROM users WHERE email = $1", [email],
  );
  const user = found.rows[0];
  if (!await verifyPassword(password, user?.password_hash ?? dummyHash) || !user) return null;
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const guest = await guestId(client, request);
    if (guest && guest !== user.owner_visitor_id) {
      await client.query("UPDATE projects SET visitor_id = $1 WHERE visitor_id = $2", [user.owner_visitor_id, guest]);
    }
    if (guest) await revokeGuest(client, guest);
    const token = await issueAccountSession(client, user.id);
    await client.query("COMMIT");
    return token;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
