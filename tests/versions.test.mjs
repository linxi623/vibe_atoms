import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { chromium } from "playwright-core";

const adminUrl = process.env.DATABASE_URL;
const name = `vibe_e_test_${randomBytes(6).toString("hex")}`;
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const html = (label) => `<!doctype html><html><head><title>${label}</title><style>body{font-family:Arial;background:#fff;color:#143b2b}</style></head><body><h1>${label}</h1><button id="action">Run ${label}</button><output id="result"></output><script>document.getElementById('action').addEventListener('click',()=>{document.getElementById('result').textContent='Done ${label}'});</script></body></html>`;

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
    try { if ((await fetch(`${origin}/api/projects`)).status === 401) return { child, origin }; }
    catch { /* listener not ready */ }
    await delay(100);
  }
  child.kill();
  throw new Error(output);
}

async function api(origin, path, { cookie, method = "GET", body, key, originHeader } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET" ? { Origin: originHeader ?? origin } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") };
}

test("E: version diff, confirmed restore, ownership, lock and idempotency", { timeout: 120000 }, async (t) => {
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
  let modelCalls = 0;
  let hold = false;
  let signal;
  let database;
  t.after(async () => {
    release?.();
    await browser?.close();
    if (app?.child.exitCode === null) { app.child.kill(); await once(app.child, "exit"); }
    await new Promise((resolve) => model?.close(resolve) ?? resolve());
    await database?.end();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await command(["scripts/migrate.mjs"], { DATABASE_URL: isolated.toString() });
  database = new pg.Client({ connectionString: isolated.toString() });
  await database.connect();

  model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    modelCalls++;
    const body = JSON.parse(raw);
    const planning = body.messages[0].content.includes("规划器");
    const prompt = body.messages.at(-1).content;
    if (planning && hold) {
      signal?.();
      await new Promise((resolve) => { release = resolve; });
    }
    const label = prompt.includes("second") ? "second" : prompt.includes("third") ? "third" : "first";
    const content = planning
      ? JSON.stringify({ summary: `规划 ${label}`, requirements: ["按钮"], interactions: ["运行"] })
      : JSON.stringify({ html: html(label), summary: `版本 ${label}` });
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const port = await freePort();
  await new Promise((resolve) => model.listen(port, "127.0.0.1", resolve));
  app = await start(isolated.toString(), `http://127.0.0.1:${port}`);
  await mkdir("test-results", { recursive: true });
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(app.origin);
  await page.getByLabel("应用需求").fill("first interactive tool");
  await page.getByRole("button", { name: "发送需求" }).click();
  await page.getByText("当前版本 v1").waitFor();
  const project = new URL(page.url()).searchParams.get("project");
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const versionsPath = `/api/projects/${project}/versions`;
  const v1 = (await api(app.origin, versionsPath, { cookie })).data.versions[0];
  await page.getByLabel("应用需求").fill("second interactive tool");
  await page.getByRole("button", { name: "发送需求" }).click();
  await page.getByText("当前版本 v2").waitFor();
  const v2 = (await api(app.origin, versionsPath, { cookie })).data.versions[0];
  assert.notEqual(v1.id, v2.id);
  assert.equal((await api(app.origin, `${versionsPath}/${v1.id}`, { cookie })).data.version.html, html("first"));
  assert.equal((await api(app.origin, `${versionsPath}/${v2.id}`, { cookie })).data.version.html, html("second"));

  await page.getByRole("tab", { name: "差异" }).click();
  await page.getByLabel("v1 与 v2 源码差异").waitFor();
  assert.match(await page.locator(".diff-added").allTextContents().then((parts) => parts.join("")), /second/);
  assert.match(await page.locator(".diff-removed").allTextContents().then((parts) => parts.join("")), /first/);
  await page.screenshot({ path: "test-results/e-desktop-diff.png", fullPage: true });
  await page.getByLabel("选择版本").selectOption(v1.id);
  await page.getByText("预览版本 v1 · 历史").waitFor();
  await page.getByRole("tab", { name: "代码" }).click();
  assert.equal(await page.getByLabel("版本 v1 源码").textContent(), html("first"));
  page.once("dialog", (dialog) => {
    assert.match(dialog.message(), /v1.*新的当前版本/);
    return dialog.dismiss();
  });
  await page.getByRole("button", { name: "恢复 v1" }).click();
  assert.equal((await api(app.origin, `/api/projects/${project}`, { cookie })).data.project.currentVersionId, v2.id);
  page.once("dialog", (dialog) => dialog.accept());
  const callsBeforeRestore = modelCalls;
  await page.getByRole("button", { name: "恢复 v1" }).click();
  await page.getByText("当前版本 v3").waitFor();
  assert.equal(modelCalls, callsBeforeRestore, "restore must not call the model");
  const v3 = (await api(app.origin, versionsPath, { cookie })).data.versions[0];
  assert.equal(v3.restoredFromId, v1.id);
  assert.equal((await api(app.origin, `${versionsPath}/${v3.id}`, { cookie })).data.version.html, html("first"));
  await page.frameLocator('iframe[title="预览版本 v3"]').getByRole("heading", { name: "first" }).waitFor();
  await page.frameLocator('iframe[title="预览版本 v3"]').getByRole("button", { name: "Run first" }).click();
  await page.frameLocator('iframe[title="预览版本 v3"]').getByText("Done first").waitFor();
  await page.getByRole("tab", { name: "代码" }).click();
  assert.equal(await page.getByLabel("版本 v3 源码").textContent(), html("first"));
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 HTML" }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "vibe-atoms-v3.html");
  assert.equal(await readFile(await download.path(), "utf8"), html("first"));
  assert.deepEqual((await api(app.origin, versionsPath, { cookie })).data.versions.map((v) => v.id), [v3.id, v2.id, v1.id]);
  await page.reload();
  await page.getByText("当前版本 v3").waitFor();
  await page.frameLocator('iframe[title="预览版本 v3"]').getByRole("heading", { name: "first" }).waitFor();
  await page.getByRole("tab", { name: "差异" }).click();
  await page.getByLabel("比较版本").selectOption(v1.id);
  await page.getByText("源码相同").waitFor();
  assert.equal(await page.locator(".diff-added, .diff-removed").count(), 0);

  const other = await api(app.origin, "/api/session", { method: "POST" });
  const stranger = other.cookie.split(";")[0];
  assert.equal((await api(app.origin, versionsPath, { cookie: stranger })).status, 404);
  assert.equal((await api(app.origin, `${versionsPath}/${v1.id}`, { cookie: stranger })).status, 404);
  const restorePath = `/api/projects/${project}/restore`;
  assert.equal((await api(app.origin, restorePath, { cookie: stranger, method: "POST", key: randomUUID(), body: { versionId: v1.id } })).status, 404);
  assert.equal((await api(app.origin, restorePath, { method: "POST", key: randomUUID(), body: { versionId: v1.id } })).status, 401);
  assert.equal((await api(app.origin, restorePath, { cookie, method: "POST", key: randomUUID(), body: { versionId: v1.id }, originHeader: "https://foreign.example" })).status, 403);
  assert.equal((await api(app.origin, restorePath, { cookie, method: "POST", body: { versionId: v1.id } })).status, 400);
  assert.equal((await api(app.origin, restorePath, { cookie, method: "POST", key: randomUUID(), body: { versionId: randomUUID() } })).status, 404);
  const ownOther = await api(app.origin, "/api/projects", { cookie, method: "POST", body: { name: "Other" } });
  assert.equal((await api(app.origin, `/api/projects/${ownOther.data.project.id}/restore`,
    { cookie, method: "POST", key: randomUUID(), body: { versionId: v1.id } })).status, 404);

  const repeatedKey = randomUUID();
  const duplicate = await Promise.all([1, 2, 3].map(() =>
    api(app.origin, restorePath, { cookie, method: "POST", key: repeatedKey, body: { versionId: v2.id } })));
  assert.deepEqual(duplicate.map((item) => item.status).sort(), [200, 200, 201]);
  assert.equal(new Set(duplicate.map((item) => item.data.versionId)).size, 1);
  const v4 = duplicate[0].data.versionId;
  assert.equal((await api(app.origin, restorePath, { cookie, method: "POST", key: repeatedKey, body: { versionId: v1.id } })).status, 409);
  assert.equal((await api(app.origin, `${versionsPath}/${v4}`, { cookie })).data.version.html, html("second"));
  assert.equal((await api(app.origin, `/api/projects/${project}`, { cookie })).data.project.currentVersionId, v4);
  assert.equal((await api(app.origin, versionsPath, { cookie })).data.versions.length, 4);
  assert.equal(modelCalls, callsBeforeRestore);

  hold = true;
  const started = new Promise((resolve) => { signal = resolve; });
  const generation = api(app.origin, `/api/projects/${project}/generate`,
    { cookie, method: "POST", key: randomUUID(), body: { prompt: "third interactive tool" } });
  await started;
  assert.equal((await api(app.origin, restorePath, { cookie, method: "POST", key: randomUUID(), body: { versionId: v1.id } })).status, 409);
  assert.equal((await api(app.origin, `/api/projects/${project}`, { cookie })).data.project.currentVersionId, v4);
  release();
  assert.equal((await generation).status, 201);
  hold = false;

  await database.query(`CREATE OR REPLACE FUNCTION fail_restore() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated restore failure'; END $$`);
  await database.query("CREATE TRIGGER fail_restore BEFORE INSERT ON versions FOR EACH ROW EXECUTE FUNCTION fail_restore()");
  const beforeFailure = (await api(app.origin, `/api/projects/${project}`, { cookie })).data.project.currentVersionId;
  assert.equal((await api(app.origin, restorePath, { cookie, method: "POST", key: randomUUID(), body: { versionId: v1.id } })).status, 503);
  assert.equal((await api(app.origin, `/api/projects/${project}`, { cookie })).data.project.currentVersionId, beforeFailure);
  await database.query("DROP TRIGGER fail_restore ON versions");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "结果" }).click();
  await page.getByText("当前版本 v5").waitFor();
  await page.getByRole("tab", { name: "差异" }).click();
  await page.getByLabel("比较版本").selectOption(v1.id);
  await page.getByLabel("v1 与 v5 源码差异").waitFor();
  assert.match(await page.locator(".diff-added").allTextContents().then((parts) => parts.join("")), /second/);
  await page.screenshot({ path: "test-results/e-mobile-diff.png", fullPage: true });
  const layout = await page.evaluate(() => [...document.querySelectorAll(".preview, .preview-toolbar, .diff-heading, .diff-stage")]
    .filter((el) => getComputedStyle(el).display !== "none")
    .map((el) => ({ rect: el.getBoundingClientRect().toJSON(), width: document.documentElement.clientWidth })));
  assert.ok(layout.every(({ rect, width }) => rect.left >= 0 && rect.right <= width + 1), JSON.stringify(layout));
});
