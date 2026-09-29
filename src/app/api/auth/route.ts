import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { errorResponse, json, sameOrigin } from "@/lib/http";
import { cookieName, digest, sessionToken } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = sessionToken(request);
  if (!token) return json({ email: null });
  try {
    const result = await db().query<{ email: string }>(
      `SELECT u.email FROM account_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`, [digest(token)],
    );
    return json({ email: result.rows[0]?.email ?? null });
  } catch {
    return errorResponse("账户暂不可用", 503);
  }
}

export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request)) return errorResponse("Invalid origin", 403);
  const token = sessionToken(request);
  try {
    if (token) await db().query("DELETE FROM account_sessions WHERE token_hash = $1", [digest(token)]);
    const response = json({ ready: true });
    response.cookies.delete(cookieName);
    return response;
  } catch {
    return errorResponse("退出暂不可用", 503);
  }
}
