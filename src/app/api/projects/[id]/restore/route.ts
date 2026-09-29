import { NextRequest } from "next/server";
import { uuid } from "@/lib/api";
import { errorResponse, json, sameOrigin } from "@/lib/http";
import { restoreVersion } from "@/lib/restore";
import { visitorId } from "@/lib/session";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  if (!sameOrigin(request)) return errorResponse("Invalid origin", 403);
  try {
    const owner = await visitorId(request);
    if (!owner) return errorResponse("Session required", 401);
    const { id } = await context.params;
    if (!uuid.test(id)) return errorResponse("Project not found", 404);
    const body = await request.json();
    if (typeof body?.versionId !== "string" || !uuid.test(body.versionId)) {
      return errorResponse("Valid versionId required", 400);
    }
    const key = request.headers.get("Idempotency-Key");
    if (!key || key.length > 128 || !/^[A-Za-z0-9_-]+$/.test(key)) {
      return errorResponse("Valid Idempotency-Key required", 400);
    }
    const result = await restoreVersion(owner, id, body.versionId, key);
    if (result.kind === "not_found") return errorResponse("Project not found", 404);
    if (result.kind === "version_not_found") return errorResponse("Version not found", 404);
    if (result.kind === "conflict") return errorResponse("Project already has a running task or idempotency key conflicts", 409);
    return json({ versionId: result.versionId, replayed: result.kind === "existing" },
      result.kind === "created" ? 201 : 200);
  } catch (error) {
    if (error instanceof SyntaxError) return errorResponse("Invalid JSON", 400);
    return errorResponse("Database unavailable", 503);
  }
}
