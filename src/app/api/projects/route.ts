import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { errorResponse, json, limitResponse, readJson, sameOrigin } from "@/lib/http";
import { clientIpKey, reserveWrite } from "@/lib/limits";
import { visitorId } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const owner = await visitorId(request);
    if (!owner) return errorResponse("Session required", 401);
    const result = await db().query(
      `SELECT id, name, current_version_id AS "currentVersionId",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM projects WHERE visitor_id = $1 ORDER BY updated_at DESC LIMIT 100`,
      [owner],
    );
    return json({ projects: result.rows });
  } catch {
    return errorResponse("Database unavailable", 503);
  }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return errorResponse("Invalid origin", 403);
  try {
    const owner = await visitorId(request);
    if (!owner) return errorResponse("Session required", 401);
    const body = await readJson(request) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return errorResponse("Name must be 1-80 characters", 400);
    await reserveWrite(owner, clientIpKey(request));
    const result = await db().query(
      `INSERT INTO projects(id, visitor_id, name) VALUES ($1, $2, $3)
       RETURNING id, name, current_version_id AS "currentVersionId",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [randomUUID(), owner, name],
    );
    return json({ project: result.rows[0] }, 201);
  } catch (error) {
    if (error instanceof SyntaxError) return errorResponse("Invalid JSON", 400);
    const limited = limitResponse(error);
    if (limited) return limited;
    return errorResponse("Database unavailable", 503);
  }
}
