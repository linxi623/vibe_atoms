import { NextRequest } from "next/server";
import { ownedProject } from "@/lib/api";
import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const { owner, found } = await ownedProject(request, id);
    if (!owner) return errorResponse("Session required", 401);
    if (!found) return errorResponse("Project not found", 404);
    const result = await db().query(
      `SELECT id, role, content, task_id AS "taskId", created_at AS "createdAt"
       FROM messages WHERE project_id = $1 ORDER BY created_at, id LIMIT 500`,
      [id],
    );
    return json({ messages: result.rows });
  } catch {
    return errorResponse("Database unavailable", 503);
  }
}
