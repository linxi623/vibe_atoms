import { NextRequest } from "next/server";
import { credentials, register, throttleAuth } from "@/lib/auth";
import { errorResponse, json, limitResponse, readJson, sameOrigin } from "@/lib/http";
import { setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return errorResponse("Invalid origin", 403);
  try {
    const input = credentials(await readJson(request));
    if (!input) return errorResponse("邮箱或密码格式不正确（密码需为 12-128 位）", 400);
    await throttleAuth(request, input.email);
    const token = await register(request, input.email, input.password);
    const response = json({ email: input.email }, 201);
    setSessionCookie(response, token);
    return response;
  } catch (error) {
    const limited = limitResponse(error);
    if (limited) return limited;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return errorResponse("此邮箱已注册", 409);
    }
    return errorResponse("注册暂不可用", 503);
  }
}
