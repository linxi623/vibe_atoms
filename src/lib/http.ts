import { NextRequest, NextResponse } from "next/server";
import { LimitError } from "@/lib/limits";

export class RequestBodyError extends Error {
  constructor(public readonly status: 400 | 413, message: string) {
    super(message);
  }
}

export async function readJson(request: NextRequest, maxBytes = 16_384): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError(400, "Invalid JSON");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError(413, "Request body too large");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400, "Invalid JSON");
  } finally {
    reader.releaseLock();
  }
}

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
    const expected = process.env.APP_ORIGIN ?? (process.env.NODE_ENV === "production" ? null : target.origin);
    if (!expected) return false;
    return source.origin === expected;
  } catch {
    return false;
  }
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function limitResponse(error: unknown): NextResponse | null {
  return error instanceof LimitError || error instanceof RequestBodyError
    ? errorResponse(error.message, error.status) : null;
}
