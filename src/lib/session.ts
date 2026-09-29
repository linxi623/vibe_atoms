import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reserveSession } from "@/lib/limits";

const cookieName = "vibe_session";
const sessionAge = 60 * 60 * 24 * 30;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function visitorId(request: NextRequest): Promise<string | null> {
  const token = request.cookies.get(cookieName)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await db().query<{ id: string }>(
    "SELECT id FROM visitors WHERE token_hash = $1",
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
  response.cookies.set(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionAge,
  });
}
