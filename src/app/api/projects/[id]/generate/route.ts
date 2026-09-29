import { NextRequest } from "next/server";
import { ownedProject, uuid } from "@/lib/api";
import { createTask, executeTask, validatePrompt } from "@/lib/generation";
import { errorResponse, json, sameOrigin } from "@/lib/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  if (!sameOrigin(request)) return errorResponse("Invalid origin", 403);
  try {
    const { id } = await context.params;
    const { owner, found } = await ownedProject(request, id);
    if (!owner) return errorResponse("Session required", 401);
    if (!found) return errorResponse("Project not found", 404);
    const body = await request.json();
    const prompt = validatePrompt(body?.prompt);
    const key = request.headers.get("Idempotency-Key");
    if (!key || key.length > 128 || !/^[A-Za-z0-9_-]+$/.test(key)) return errorResponse("Valid Idempotency-Key required", 400);
    const retryOfId = body?.retryOfId;
    if (retryOfId !== undefined && (typeof retryOfId !== "string" || !uuid.test(retryOfId))) {
      return errorResponse("Invalid retry task", 400);
    }
    const creation = await createTask(owner, id, prompt, key, retryOfId);
    if (creation.kind === "not_found") return errorResponse("Project not found", 404);
    if (creation.kind === "conflict") return errorResponse("Project already has a running task or idempotency key conflicts", 409);
    if (creation.kind === "invalid_retry") return errorResponse("Retry task must be a failed task in this project", 400);
    if (creation.kind === "existing") return json({ task: creation.task, replayed: true }, creation.task.status === "running" ? 202 : 200);
    const outcome = await executeTask(creation.taskId, prompt, creation.baseVersionId);
    if ("error" in outcome) {
      const status = outcome.errorCode === "TIMEOUT" ? 504 : outcome.errorCode === "STORAGE" ? 503 : 502;
      return json({ taskId: creation.taskId, error: outcome.error, errorCode: outcome.errorCode, retryable: outcome.retryable }, status);
    }
    return json({ taskId: creation.taskId, versionId: outcome.versionId, status: "succeeded" }, 201);
  } catch (error) {
    if (error instanceof SyntaxError) return errorResponse("Invalid JSON", 400);
    if (error instanceof Error && /需求文本/.test(error.message)) return errorResponse(error.message, 400);
    return errorResponse("Database unavailable", 503);
  }
}
