import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { visitorId } from "@/lib/session";

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ownedProject(request: NextRequest, id: string) {
  const owner = await visitorId(request);
  if (!owner) return { owner: null, found: false };
  if (!uuid.test(id)) return { owner, found: false };
  const result = await db().query("SELECT 1 FROM projects WHERE id = $1 AND visitor_id = $2", [id, owner]);
  return { owner, found: !!result.rows[0] };
}
