import { db } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";
import { modelConfigured } from "@/lib/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const migrated = await db().query(
      "SELECT 1 FROM schema_migrations WHERE name = '0004_public_limits.sql'",
    );
    if (!migrated.rowCount) return errorResponse("Service unavailable", 503);
    const model = modelConfigured();
    return json({ status: model ? "ok" : "unavailable", checks: { database: true, model } }, model ? 200 : 503);
  } catch {
    return errorResponse("Service unavailable", 503);
  }
}
