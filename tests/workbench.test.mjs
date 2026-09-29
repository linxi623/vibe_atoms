import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { chromium } from "playwright-core";

const adminUrl = process.env.DATABASE_URL;
const name = `vibe_c_test_${randomBytes(6).toString("hex")}`;
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const html = (label) => `<!doctype html><html><head><title>${label}</title><style>body{color:green}</style></head><body><button id="add">${label}</button><script>document.getElementById('add').addEventListener('click',()=>{});</script></body></html>`;

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function command(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, output);
}

async function start(databaseUrl, modelBase) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: origin,
      MODEL_BASE_URL: modelBase, MODEL_API_KEY: "local-test-placeholder", MODEL_NAME: "mock",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      if ((await fetch(`${origin}/api/projects`)).status === 401) return { child, origin };
    } catch { /* listener not ready */ }
    await delay(100);
  }
  child.kill();
  throw new Error(output);
}

test("C: browser workbench first run, iteration, failure, linked retry and mobile recovery", { timeout: 120000 }, async (t) => {
  assert.ok(adminUrl, "DATABASE_URL required");
  const isolated = new URL(adminUrl);
  isolated.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let created = false;
  let app;
  let browser;
  let model;
  let releaseIteration;
  let holdIteration = true;
  let releaseFirstGeneration;
  let holdFirstGeneration = true;
  t.after(async () => {
    releaseIteration?.();
    releaseFirstGeneration?.();
    await browser?.close();
    if (app?.child.exitCode === null) { app.child.kill(); await once(app.child, "exit"); }
    await new Promise((resolve) => model?.close(resolve) ?? resolve());
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await command(["scripts/migrate.mjs"], { DATABASE_URL: isolated.toString() });

  let failOnce = true;
  model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const planning = body.messages[0].content.includes("规划器");
    const prompt = body.messages.at(-1).content;
    await delay(450);
    if (planning && prompt.includes("增加颜色") && holdIteration) {
      holdIteration = false;
      await new Promise((resolve) => { releaseIteration = resolve; });
    }
    if (!planning && prompt.includes("自定义植物") && holdFirstGeneration) {
      holdFirstGeneration = false;
      await new Promise((resolve) => { releaseFirstGeneration = resolve; });
    }
    if (planning && prompt.includes("故障回归") && failOnce) {
      failOnce = false;
      res.writeHead(503).end();
      return;
    }
    const label = prompt.includes("故障回归") ? "recovered" : prompt.includes("增加颜色") ? "second" : "first";
    const content = planning
      ? JSON.stringify({ summary: `规划 ${label}`, requirements: ["输入"], interactions: ["点击"] })
      : JSON.stringify({ html: html(label), summary: `版本 ${label}` });
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const modelPort = await freePort();
  await new Promise((resolve) => model.listen(modelPort, "127.0.0.1", resolve));
  app = await start(isolated.toString(), `http://127.0.0.1:${modelPort}`);
  await mkdir("test-results", { recursive: true });
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(app.origin);
  await page.getByLabel("应用需求").fill("自定义植物养护提醒器，支持记录浇水");
  await page.getByRole("button", { name: "发送需求" }).click();
  await page.getByText("规划需求", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "发送需求" }).isDisabled(), true);
  await page.getByText("生成代码", { exact: true }).waitFor();
  releaseFirstGeneration();
  await page.getByText("生成完成", { exact: true }).waitFor();
  await page.getByText("当前版本 v1").waitFor();
  await page.screenshot({ path: "test-results/c-desktop-first.png", fullPage: true });
  assert.equal(await page.getByRole("button", { name: "发送需求" }).isDisabled(), true, "empty draft remains disabled");
  const firstId = new URL(page.url()).searchParams.get("project");
  assert.ok(firstId);

  await page.getByLabel("应用需求").fill("增加颜色主题，保留浇水记录");
  await page.getByRole("button", { name: "发送需求" }).click();
  await page.getByText("规划需求", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("规划需求", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("应用需求").isDisabled(), true);
  page.once("dialog", (dialog) => dialog.accept("第二项目"));
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByText("尚无生成结果").waitFor();
  await page.getByRole("button", { name: "自定义植物养护提醒器，支持记录浇水" }).click();
  await page.getByText("规划需求", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("应用需求").isDisabled(), true);
  releaseIteration();
  await page.getByText("当前版本 v2").waitFor();
  assert.equal(await page.getByText("生成完成", { exact: true }).count(), 2);
  await page.reload();
  await page.getByText("增加颜色主题，保留浇水记录").waitFor();
  await page.getByText("当前版本 v2").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("project"), firstId);

  await page.getByLabel("应用需求").fill("故障回归，添加提醒时间");
  await page.getByRole("button", { name: "发送需求" }).click();
  await page.getByText("生成失败", { exact: true }).waitFor();
  await page.getByText("当前版本 v2").waitFor();
  await page.getByRole("button", { name: "重试此需求" }).click();
  await page.getByText("当前版本 v3").waitFor();
  await page.getByText("关联重试", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("生成失败", { exact: true }).waitFor();
  await page.getByText("当前版本 v3").waitFor();

  await page.getByRole("button", { name: "第二项目" }).click();
  await page.getByText("尚无生成结果").waitFor();
  await page.getByRole("button", { name: "自定义植物养护提醒器，支持记录浇水" }).click();
  await page.getByText("当前版本 v3").waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "结果" }).click();
  await page.getByText("当前版本 v3").waitFor();
  await page.screenshot({ path: "test-results/c-mobile-result.png", fullPage: true });
  await page.getByRole("tab", { name: "对话" }).click();
  await page.getByRole("button", { name: "重试此需求" }).waitFor();
  await page.screenshot({ path: "test-results/c-mobile-chat.png", fullPage: true });
  const layout = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    return [...document.querySelectorAll(".topbar, .conversation, .composer, .task-status, .preview")]
      .filter((element) => getComputedStyle(element).display !== "none")
      .map((element) => ({ name: element.className, rect: element.getBoundingClientRect().toJSON(), viewport }));
  });
  assert.ok(layout.every(({ rect, viewport }) => rect.left >= 0 && rect.right <= viewport + 1), JSON.stringify(layout));
  assert.equal((await page.getByLabel("应用需求").boundingBox())?.width > 150, true);

  const cookie = (await context.cookies())[0];
  const response = await fetch(`${app.origin}/api/projects/${firstId}/tasks`, {
    headers: { Cookie: `${cookie.name}=${cookie.value}` },
  });
  const { tasks } = await response.json();
  assert.equal(tasks.length, 4);
  assert.equal(tasks[3].retryOfId, tasks[2].id);
  assert.equal(tasks[2].status, "failed");
  assert.equal(tasks[3].status, "succeeded");
  assert.equal((await fetch(`${app.origin}/api/projects/${firstId}/tasks`)).status, 401);
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await otherPage.goto(app.origin);
    await otherPage.getByText("就绪", { exact: true }).waitFor();
    const otherCookie = (await other.cookies())[0];
    assert.ok(otherCookie);
    assert.equal((await fetch(`${app.origin}/api/projects/${firstId}/tasks`, {
      headers: { Cookie: `${otherCookie.name}=${otherCookie.value}` },
    })).status, 404);
  } finally {
    await other.close();
  }
});
