import { NextRequest } from "next/server";
import { errorResponse, json, limitResponse, sameOrigin } from "@/lib/http";
import { clientIpKey } from "@/lib/limits";
import { createSession, visitorId } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return errorResponse("Invalid origin", 403);
  try {
    if (await visitorId(request)) return json({ ready: true });
    const response = json({ ready: true }, 201);
    await createSession(response, clientIpKey(request));
    return response;
  } catch (error) {
    const limited = limitResponse(error);
    if (limited) return limited;
    return errorResponse("Database unavailable", 503);
  }
}
