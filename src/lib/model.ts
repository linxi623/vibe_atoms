export type GenerationPlan = {
  summary: string;
  requirements: string[];
  interactions: string[];
};

export type ModelResult = {
  plan: GenerationPlan;
  html: string;
  summary: string;
};

export class ModelError extends Error {
  constructor(
    message: string,
    public readonly code: "MODEL_CONFIG" | "MODEL_NETWORK" | "MODEL_TIMEOUT" | "MODEL_PROVIDER" | "MODEL_FORMAT",
  ) {
    super(message);
    this.name = "ModelError";
  }
}

const timeoutMs = 90_000;
const maxPromptLength = 8_000;
const maxHtmlLength = 500_000;

function config() {
  const apiKey = process.env.MODEL_API_KEY;
  const baseUrl = process.env.MODEL_BASE_URL;
  const model = process.env.MODEL_NAME;
  if (!apiKey || !baseUrl || !model) {
    throw new ModelError("模型服务未配置", "MODEL_CONFIG");
  }
  let url: URL;
  try {
    url = new URL(`${baseUrl.replace(/\/+$/, "")}/chat/completions`);
  } catch {
    throw new ModelError("模型服务地址无效", "MODEL_CONFIG");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ModelError("模型服务地址无效", "MODEL_CONFIG");
  }
  return { apiKey, url, model };
}

function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  try {
    return JSON.parse(fenced.trim());
  } catch {
    throw new ModelError("模型返回格式无效", "MODEL_FORMAT");
  }
}

function readContent(data: unknown): string {
  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new ModelError("模型未返回内容", "MODEL_PROVIDER");
  return content;
}

async function callModel(messages: Array<{ role: "system" | "user"; content: string }>, deadline: number, maxTokens = 12_000): Promise<string> {
  const { apiKey, url, model } = config();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ModelError("生成任务超时", "MODEL_TIMEOUT");
  const controller = new AbortController();
  const configured = Number(process.env.MODEL_REQUEST_TIMEOUT_MS);
  const requestTimeout = Number.isInteger(configured) && configured >= 100 && configured <= timeoutMs ? configured : timeoutMs;
  const timer = setTimeout(() => controller.abort(), Math.min(requestTimeout, remaining));
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages,
          ...(url.hostname === "api.deepseek.com" ? { thinking: { type: "disabled" } } : {}),
        }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ModelError("模型请求超时", "MODEL_TIMEOUT");
      }
      throw new ModelError("模型网络请求失败", "MODEL_NETWORK");
    }
    if (!response.ok) throw new ModelError("模型服务拒绝请求", "MODEL_PROVIDER");
    const reader = response.body?.getReader();
    if (!reader) throw new ModelError("模型未返回内容", "MODEL_PROVIDER");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 2_000_000) {
          await reader.cancel();
          throw new ModelError("模型响应超过大小限制", "MODEL_FORMAT");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (controller.signal.aborted) throw new ModelError("模型请求超时", "MODEL_TIMEOUT");
      if (error instanceof ModelError) throw error;
      throw new ModelError("模型响应读取失败", "MODEL_NETWORK");
    }
    try {
      return readContent(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw new ModelError("模型响应协议无效", "MODEL_PROVIDER");
    }
  } finally {
    clearTimeout(timer);
  }
}

function validatePlan(value: unknown): GenerationPlan {
  const plan = value as Partial<GenerationPlan>;
  if (
    !plan ||
    typeof plan.summary !== "string" ||
    !Array.isArray(plan.requirements) ||
    !Array.isArray(plan.interactions) ||
    !plan.requirements.every((item) => typeof item === "string") ||
    !plan.interactions.every((item) => typeof item === "string")
  ) {
    throw new ModelError("规划结果格式无效", "MODEL_FORMAT");
  }
  return {
    summary: plan.summary.slice(0, 2_000),
    requirements: plan.requirements.map(String).slice(0, 20),
    interactions: plan.interactions.map(String).slice(0, 20),
  };
}

function validateHtml(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxHtmlLength) {
    throw new ModelError("生成源码格式无效", "MODEL_FORMAT");
  }
  return value;
}

async function repair(raw: string, reason: string, deadline: number, check: (html: string) => void): Promise<{ html: string; summary: string }> {
  const result = parseJson(await callModel([
    {
      role: "system",
      content: "修复模型输出。只返回 JSON：{\"html\":\"完整单文件HTML字符串\",\"summary\":\"简短摘要\"}。不要使用 Markdown 代码围栏。",
    },
    { role: "user", content: `原始输出：\n${raw.slice(0, maxHtmlLength)}\n问题：${reason}` },
  ], deadline)) as { html?: unknown; summary?: unknown };
  const html = validateHtml(result.html);
  check(html);
  return { html, summary: typeof result.summary === "string" && result.summary.trim() ? result.summary.slice(0, 2_000) : "已修复生成结果" };
}

export async function generateApplication(
  prompt: string,
  currentHtml: string | null,
  deadline: number,
  onGenerating: (plan: GenerationPlan) => Promise<void>,
  onChecking: () => Promise<void>,
  check: (html: string) => void,
): Promise<ModelResult> {
  if (prompt.length > maxPromptLength) throw new ModelError("需求文本过长", "MODEL_FORMAT");
  let repairs = 0;
  let planRaw = await callModel([
    {
      role: "system",
      content: "你是规划器。只返回 JSON：{\"summary\":\"...\",\"requirements\":[\"...\"],\"interactions\":[\"...\"]}。不要 Markdown。",
    },
    { role: "user", content: `用户需求：${prompt}\n固定基线源码：${currentHtml ?? "无，首次生成"}\n请保留已有关键交互，除非用户明确要求移除。` },
  ], deadline, 1_000);
  let plan: GenerationPlan;
  try {
    plan = validatePlan(parseJson(planRaw));
  } catch (error) {
    if (!(error instanceof ModelError) || error.code !== "MODEL_FORMAT") throw error;
    repairs++;
    planRaw = await callModel([
      { role: "system", content: "修复格式。只返回 JSON：{\"summary\":\"...\",\"requirements\":[\"...\"],\"interactions\":[\"...\"]}。" },
      { role: "user", content: planRaw },
    ], deadline, 1_000);
    plan = validatePlan(parseJson(planRaw));
  }
  await onGenerating(plan);
  const raw = await callModel([
    {
      role: "system",
      content: "你是单文件前端生成器。只返回 JSON：{\"html\":\"完整单文件HTML字符串\",\"summary\":\"简短摘要\"}。源码必须自包含，不使用外部资源、网络请求、内联事件处理器或第三方依赖。",
    },
    {
      role: "user",
      content: `需求：${prompt}\n规划：${JSON.stringify(plan)}\n当前源码：${currentHtml?.slice(0, maxHtmlLength) ?? "无"}\n请输出完整 HTML。`,
    },
  ], deadline);
  await onChecking();
  let output: { html?: unknown; summary?: unknown };
  try {
    output = parseJson(raw) as { html?: unknown; summary?: unknown };
    check(validateHtml(output.html));
  } catch (error) {
    if (!(error instanceof ModelError) || error.code !== "MODEL_FORMAT" || repairs >= 1) throw error;
    repairs++;
    output = await repair(raw, error.message, deadline, check);
  }
  return {
    plan,
    html: validateHtml(output.html),
    summary: typeof output.summary === "string" ? output.summary.slice(0, 2_000) : plan.summary,
  };
}
