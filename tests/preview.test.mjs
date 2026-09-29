import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { chromium } from "playwright-core";

const adminUrl = process.env.DATABASE_URL;
const name = `vibe_d_test_${randomBytes(6).toString("hex")}`;
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const html = (label) => `<!doctype html><html><head><title>${label}</title><style>body{font-family:Arial;background:#fff;color:#143b2b}canvas{border:1px solid #222}</style></head><body><h1>${label}</h1><input id="item"><button id="add">新增</button><ul id="items"></ul><canvas id="art" width="24" height="24"></canvas><script>document.getElementById('add').addEventListener('click',()=>{const li=document.createElement('li');li.textContent=document.getElementById('item').value;document.getElementById('items').append(li)});const c=document.getElementById('art').getContext('2d');c.fillStyle='rgb(255,0,0)';c.fillRect(0,0,24,24);</script></body></html>`;

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
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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
    env: { ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: origin, MODEL_BASE_URL: modelBase, MODEL_API_KEY: "local-test-placeholder", MODEL_NAME: "mock" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${origin}/api/projects`)).status === 401) return { child, origin }; }
    catch { /* listener not ready */ }
    await delay(100);
  }
  child.kill();
  throw new Error(output);
}

test("D: selected source, interactive isolated preview and blocked exits", { timeout: 120000 }, async (t) => {
  assert.ok(adminUrl, "DATABASE_URL required");
  const isolated = new URL(adminUrl);
  isolated.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let created = false;
  let app;
  let browser;
  let model;
  let release;
  let hold = true;
  let fail = false;
  let outbound = 0;
  t.after(async () => {
    release?.();
    await browser?.close();
    if (app?.child.exitCode === null) { app.child.kill(); await once(app.child, "exit"); }
    await new Promise((resolve) => model?.close(resolve) ?? resolve());
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await command(["scripts/migrate.mjs"], { DATABASE_URL: isolated.toString() });

  model = http.createServer(async (req, res) => {
    if (req.url !== "/chat/completions") { outbound++; res.writeHead(200).end("outbound"); return; }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const planning = body.messages[0].content.includes("规划器");
    const prompt = body.messages.at(-1).content;
    if (planning && prompt.includes("second") && hold) {
      hold = false;
      await new Promise((resolve) => { release = resolve; });
    }
    if (planning && prompt.includes("failure") && fail) { res.writeHead(503).end(); return; }
    const label = prompt.includes("second") ? "second" : "first";
    const content = planning
      ? JSON.stringify({ summary: `规划 ${label}`, requirements: ["输入"], interactions: ["新增"] })
      : JSON.stringify({ html: html(label), summary: `版本 ${label}` });
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const port = await freePort();
  await new Promise((resolve) => model.listen(port, "127.0.0.1", resolve));
  app = await start(isolated.toString(), `http://127.0.0.1:${port}`);
  await mkdir("test-results", { recursive: true });
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true });
  const page = await context.newPage();
  const documentResponse = await page.goto(app.origin);
  assert.match(documentResponse.headers()["content-security-policy"], /frame-src 'none'/);
  await page.getByLabel("应用需求").fill("自定义事项表，first");
  await page.getByRole("button", { name: "发送需求" }).click();
  await page.getByText("当前版本 v1").waitFor();
  const project = new URL(page.url()).searchParams.get("project");
  assert.ok(project);
  const versionsUrl = `${app.origin}/api/projects/${project}/versions`;
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const versions = (await (await fetch(versionsUrl, { headers: { Cookie: cookie } })).json()).versions;
  const firstId = versions[0].id;
  const firstSource = html("first");
  const frame = page.frameLocator('iframe[title="预览版本 v1"]');
  await frame.locator("#item").fill("浇水");
  await frame.locator("#add").click();
  await frame.getByText("浇水").waitFor();
  assert.deepEqual(await frame.locator("#art").evaluate((canvas) => [...canvas.getContext("2d").getImageData(10, 10, 1, 1).data]), [255, 0, 0, 255]);
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
  assert.equal(await page.locator("iframe").evaluate((el) => el.contentDocument), null);
  const security = await frame.locator("body").evaluate(async (_, probe) => {
    const outcome = {};
    for (const [name, fn] of Object.entries({
      parent: () => parent.document.body.innerHTML,
      cookie: () => parent.document.cookie,
      storage: () => parent.localStorage.length,
      selfStorage: () => localStorage.length,
      top: () => { top.location.href = "https://example.com/escape"; return "navigated"; },
      popup: () => window.open("https://example.com/escape"),
    })) {
      try { outcome[name] = fn() ?? null; } catch (error) { outcome[name] = error.name; }
    }
    try { await fetch("/api/projects"); outcome.fetch = "allowed"; }
    catch (error) { outcome.fetch = error.name; }
    const image = document.createElement("img");
    image.src = `${probe}/image-leak`;
    document.body.append(image);
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `${probe}/form-leak`;
    document.body.append(form);
    form.submit();
    return outcome;
  }, `http://127.0.0.1:${port}`);
  assert.deepEqual(security, {
    parent: "SecurityError", cookie: "SecurityError", storage: "SecurityError", selfStorage: "SecurityError",
    top: "SecurityError", popup: null, fetch: "TypeError",
  });
  await delay(400);
  assert.equal(page.url().startsWith(app.origin), true);
  assert.equal(outbound, 0);
  assert.equal(await page.locator("iframe").getAttribute("srcdoc").then((s) => s.includes("form-action 'none'")), true);
  await page.screenshot({ path: "test-results/d-desktop.png", fullPage: true });

  await page.getByRole("tab", { name: "代码" }).click();
  assert.equal(await page.getByLabel("版本 v1 源码").textContent(), firstSource);
  await page.getByRole("button", { name: "复制源码" }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), firstSource);
  let downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 HTML" }).click();
  let download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "vibe-atoms-v1.html");
  assert.equal(await readFile(await download.path(), "utf8"), firstSource);
  await page.getByRole("tab", { name: "预览" }).click();
  await page.getByRole("button", { name: "刷新预览" }).click();
  assert.equal(await frame.getByText("浇水").count(), 0);
  await page.getByRole("button", { name: "移动视口" }).click();
  assert.ok((await page.locator("iframe").boundingBox()).width <= 390);

  await page.getByLabel("应用需求").fill("second，增加主题");
  await page.getByRole("button", { name: "发送需求" }).click();
  await page.getByText("规划需求", { exact: true }).waitFor();
  await page.getByText("当前版本 v1").waitFor();
  assert.equal(await frame.getByRole("heading", { name: "first" }).count(), 1);
  release();
  await page.getByText("当前版本 v2").waitFor();
  const secondSource = html("second");
  await page.getByRole("tab", { name: "代码" }).click();
  assert.equal(await page.getByLabel("版本 v2 源码").textContent(), secondSource);
  downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 HTML" }).click();
  download = await downloadPromise;
  assert.equal(await readFile(await download.path(), "utf8"), secondSource);
  await page.getByLabel("选择版本").selectOption(firstId);
  await page.getByText("预览版本 v1").waitFor();
  assert.equal(await page.getByLabel("版本 v1 源码").textContent(), firstSource);
  await page.getByRole("tab", { name: "预览" }).click();
  await frame.getByRole("heading", { name: "first" }).waitFor();
  fail = true;
  await page.getByLabel("应用需求").fill("failure，模拟错误");
  await page.getByRole("button", { name: "发送需求" }).click();
  await page.getByText("生成失败", { exact: true }).waitFor();
  await frame.getByRole("heading", { name: "first" }).waitFor();
  await page.reload();
  await page.getByText("当前版本 v2").waitFor();
  await page.frameLocator('iframe[title="预览版本 v2"]').getByRole("heading", { name: "second" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "结果" }).click();
  await page.getByRole("button", { name: "移动视口" }).click();
  await page.screenshot({ path: "test-results/d-mobile.png", fullPage: true });
  const layout = await page.evaluate(() => [...document.querySelectorAll(".result-pane, .preview-toolbar, .preview-stage, iframe")]
    .map((el) => ({ name: el.tagName, rect: el.getBoundingClientRect().toJSON(), width: document.documentElement.clientWidth })));
  assert.ok(layout.every(({ rect, width }) => rect.left >= 0 && rect.right <= width + 1), JSON.stringify(layout));
  assert.ok((await page.screenshot()).length > 15_000, "mobile screenshot contains actual page");
  await page.frameLocator('iframe[title="预览版本 v2"]').locator("body").evaluate((_, probe) => {
    location.href = `${probe}/navigation-leak`;
  }, `http://127.0.0.1:${port}`);
  await delay(500);
  assert.equal(outbound, 0, "generated code must not navigate to an external endpoint");
  await page.getByRole("button", { name: "刷新预览" }).click();
  await page.frameLocator('iframe[title="预览版本 v2"]').getByRole("heading", { name: "second" }).waitFor();
});
