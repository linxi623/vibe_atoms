import { NextRequest } from "next/server";
import { ownedProject } from "@/lib/api";
import { db } from "@/lib/db";
import { reapStaleTasks } from "@/lib/generation";
import { errorResponse, json } from "@/lib/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const { owner, found } = await ownedProject(request, id);
    if (!owner) return errorResponse("Session required", 401);
    if (!found) return errorResponse("Project not found", 404);
    await reapStaleTasks(db(), id);
    const result = await db().query(
      `SELECT id, project_id AS "projectId", base_version_id AS "baseVersionId",
              status, stage, plan, error_code AS "errorCode",
              error_detail AS "errorDetail", retry_of_id AS "retryOfId",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM tasks WHERE project_id = $1 ORDER BY created_at, id LIMIT 500`,
      [id],
    );
    return json({ tasks: result.rows });
  } catch {
    return errorResponse("Database unavailable", 503);
  }
}
