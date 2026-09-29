import { NextRequest } from "next/server";
import { credentials, login, throttleAuth } from "@/lib/auth";
import { errorResponse, json, limitResponse, readJson, sameOrigin } from "@/lib/http";
import { setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return errorResponse("Invalid origin", 403);
  try {
    const input = credentials(await readJson(request));
    if (!input) return errorResponse("邮箱或密码格式不正确", 400);
    await throttleAuth(request, input.email);
    const token = await login(request, input.email, input.password);
    if (!token) return errorResponse("邮箱或密码错误", 401);
    const response = json({ email: input.email });
    setSessionCookie(response, token);
    return response;
  } catch (error) {
    const limited = limitResponse(error);
    return limited ?? errorResponse("登录暂不可用", 503);
  }
}
