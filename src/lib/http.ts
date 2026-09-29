import { NextRequest, NextResponse } from "next/server";

export function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const target = new URL(request.url);
    const source = new URL(origin);
    // Behind a proxy, the configured public origin is the trusted comparison target.
    const expected = process.env.APP_ORIGIN ?? target.origin;
    return source.origin === expected;
  } catch {
    return false;
  }
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
