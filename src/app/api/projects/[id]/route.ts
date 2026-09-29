import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { errorResponse, json, sameOrigin } from "@/lib/http";
import { visitorId } from "@/lib/session";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const owner = await visitorId(request);
    if (!owner) return errorResponse("Session required", 401);
    const { id } = await context.params;
    const result = await db().query(
      `SELECT id, name, current_version_id AS "currentVersionId",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM projects WHERE id = $1 AND visitor_id = $2`,
      [id, owner],
    );
    if (!result.rows[0]) return errorResponse("Project not found", 404);
    return json({ project: result.rows[0] });
  } catch {
    return errorResponse("Database unavailable", 503);
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  if (!sameOrigin(request)) return errorResponse("Invalid origin", 403);
  try {
    const owner = await visitorId(request);
    if (!owner) return errorResponse("Session required", 401);
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return errorResponse("Name must be 1-80 characters", 400);
    const { id } = await context.params;
    const result = await db().query(
      `UPDATE projects SET name = $3, updated_at = now()
       WHERE id = $1 AND visitor_id = $2
       RETURNING id, name, current_version_id AS "currentVersionId",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id, owner, name],
    );
    if (!result.rows[0]) return errorResponse("Project not found", 404);
    return json({ project: result.rows[0] });
  } catch (error) {
    if (error instanceof SyntaxError) return errorResponse("Invalid JSON", 400);
    return errorResponse("Database unavailable", 503);
  }
}
