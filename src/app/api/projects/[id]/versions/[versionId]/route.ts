import { NextRequest } from "next/server";
import { ownedProject, uuid } from "@/lib/api";
import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; versionId: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const { id, versionId } = await context.params;
    const { owner, found } = await ownedProject(request, id);
    if (!owner) return errorResponse("Session required", 401);
    if (!found || !uuid.test(versionId)) return errorResponse("Version not found", 404);
    const result = await db().query(
      `SELECT id, sequence, html, summary, task_id AS "taskId",
              restored_from_id AS "restoredFromId", created_at AS "createdAt"
       FROM versions WHERE id = $1 AND project_id = $2`,
      [versionId, id],
    );
    if (!result.rows[0]) return errorResponse("Version not found", 404);
    return json({ version: result.rows[0] });
  } catch {
    return errorResponse("Database unavailable", 503);
  }
}
