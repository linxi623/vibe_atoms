import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reserveSession } from "@/lib/limits";

export const cookieName = "vibe_session";
export const sessionAge = 60 * 60 * 24 * 30;

export function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionToken(request: NextRequest): string | null {
  const token = request.cookies.get(cookieName)?.value;
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionAge,
  });
}

export async function visitorId(request: NextRequest): Promise<string | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const result = await db().query<{ id: string }>(
    `SELECT owner_visitor_id AS id FROM account_sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()
     UNION ALL SELECT id FROM visitors WHERE token_hash = $1 LIMIT 1`,
    [digest(token)],
  );
  return result.rows[0]?.id ?? null;
}

export async function createSession(response: NextResponse, ip: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await reserveSession(client, ip);
    await client.query("INSERT INTO visitors(id, token_hash) VALUES ($1, $2)", [
      randomUUID(), digest(token),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  setSessionCookie(response, token);
}
