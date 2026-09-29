import { NextRequest } from "next/server";
import { uuid } from "@/lib/api";
import { db } from "@/lib/db";
import { reapStaleTasks } from "@/lib/generation";
import { errorResponse, json } from "@/lib/http";
import { visitorId } from "@/lib/session";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const owner = await visitorId(request);
    if (!owner) return errorResponse("Session required", 401);
    const { id } = await context.params;
    if (!uuid.test(id)) return errorResponse("Task not found", 404);
    await reapStaleTasks(db());
    const result = await db().query(
      `SELECT t.id, t.project_id AS "projectId", t.base_version_id AS "baseVersionId",
              t.status, t.stage, t.plan, t.error_code AS "errorCode",
              t.error_detail AS "errorDetail", t.retry_of_id AS "retryOfId",
              t.created_at AS "createdAt", t.updated_at AS "updatedAt",
              v.id AS "versionId"
       FROM tasks t JOIN projects p ON p.id = t.project_id
       LEFT JOIN versions v ON v.task_id = t.id
       WHERE t.id = $1 AND p.visitor_id = $2`,
      [id, owner],
    );
    if (!result.rows[0]) return errorResponse("Task not found", 404);
    return json({ task: result.rows[0] });
  } catch {
    return errorResponse("Database unavailable", 503);
  }
}
