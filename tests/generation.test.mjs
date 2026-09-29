import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";

const adminUrl = process.env.DATABASE_URL;
const name = `vibe_b_test_${randomBytes(6).toString("hex")}`;
const nextCli = "node_modules/next/dist/bin/next";
const html = (text) => `<!doctype html><html><head><title>${text}</title><style>body{color:green}</style></head><body><button id="add">${text}</button><script>function update(){return true}document.getElementById('add').addEventListener('click',update);</script></body></html>`;
const plan = { summary: "计划", requirements: ["需求"], interactions: ["点击"] };
let requests = [];
let mode = "success";
let hold;
let released;

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
  assert.equal(code, 0, `${args.join(" ")} failed:\n${output}`);
}

async function start(databaseUrl, modelBase, extra = {}) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [nextCli, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: origin,
      MODEL_BASE_URL: modelBase, MODEL_API_KEY: "local-test-placeholder", MODEL_NAME: "mock",
      MODEL_REQUEST_TIMEOUT_MS: "500",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Next exited early:\n${output}`);
    try {
      if ((await fetch(`${origin}/api/projects`)).status === 401) return { child, origin };
    } catch { /* listener not ready */ }
    await delay(100);
  }
  child.kill();
  throw new Error(`Next did not become ready:\n${output}`);
}

async function stop(server) {
  if (server?.child.exitCode === null) {
    server.child.kill();
    await once(server.child, "exit");
  }
}

async function api(origin, path, { cookie, method = "GET", body, key } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET" ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") };
}

async function waitFor(origin, project, cookie) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const versions = await api(origin, `/api/projects/${project}/versions`, { cookie });
    const messages = await api(origin, `/api/projects/${project}/messages`, { cookie });
    if (messages.data.messages.length) return { versions, messages };
    await delay(20);
  }
  throw new Error("Task did not begin");
}

test("B: PostgreSQL transactions, model failures, retry, idempotency and persistence", { timeout: 120000 }, async (t) => {
  assert.ok(adminUrl, "DATABASE_URL must name an existing PostgreSQL database");
  const url = new URL(adminUrl);
  const isolated = new URL(adminUrl);
  isolated.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  let created = false;
  let app;
  let model;
  const database = new pg.Client({ connectionString: isolated.toString() });
  t.after(async () => {
    await stop(app);
    await new Promise((resolve) => model?.close(resolve) ?? resolve());
    await database.end();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await command(["scripts/migrate.mjs"], { DATABASE_URL: isolated.toString() });
  await database.connect();

  model = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    requests.push(data);
    const step = requests.length;
    if (mode === "hold" && step % 2 === 1) {
      hold?.();
      await new Promise((resolve) => { released = resolve; });
    }
    if (mode === "timeout") return;
    if (mode === "network") { req.socket.destroy(); return; }
    if (mode === "provider") {
      res.writeHead(503).end();
      return;
    }
    let content;
    if (mode === "bad") content = "broken";
    else if (mode === "repair" && step === 2) content = "not json";
    else if (mode === "repair" && step === 3) content = JSON.stringify({ html: html("repaired"), summary: "修复" });
    else if (mode === "unsafe" && step % 2 === 0) content = JSON.stringify({ html: html("bad").replace("</body>", "<img src='https://example.org/x'></body>"), summary: "bad" });
    else if (mode === "unsafe" && step === 3) content = JSON.stringify({ html: html("bad").replace("</body>", "<img src='https://example.org/x'></body>"), summary: "bad" });
    else content = step % 2 === 1 ? JSON.stringify(plan) : JSON.stringify({ html: html(`result-${step}`), summary: `结果 ${step}` });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const modelPort = await freePort();
  await new Promise((resolve) => model.listen(modelPort, "127.0.0.1", resolve));
  app = await start(isolated.toString(), `http://127.0.0.1:${modelPort}`);
  let { origin } = app;
  const a = await api(origin, "/api/session", { method: "POST" });
  const b = await api(origin, "/api/session", { method: "POST" });
  const cookie = a.cookie.split(";")[0];
  const other = b.cookie.split(";")[0];
  const createdProject = await api(origin, "/api/projects", { cookie, method: "POST", body: { name: "B test" } });
  const id = createdProject.data.project.id;
  const path = `/api/projects/${id}/generate`;
  const submit = (prompt, key = randomUUID(), extras = {}) => api(origin, path, { cookie, method: "POST", key, body: { prompt, ...extras } });
  assert.equal((await api(origin, path, { cookie: other, method: "POST", key: "foreign", body: { prompt: "no" } })).status, 404);
  assert.equal((await api(origin, path, { cookie, method: "POST", body: { prompt: "no" } })).status, 400);
  assert.equal((await submit(" ")).status, 400);

  const firstKey = randomUUID();
  const first = await submit("一页植物养护提醒器，支持勾选浇水", firstKey);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const version1 = first.data.versionId;
  assert.equal((await submit("一页植物养护提醒器，支持勾选浇水", firstKey)).data.task.id, first.data.taskId);
  assert.equal((await submit("different", firstKey)).status, 409);
  const task1 = await api(origin, `/api/tasks/${first.data.taskId}`, { cookie });
  assert.equal(task1.data.task.status, "succeeded");
  assert.equal(task1.data.task.plan.summary, "计划");
  assert.equal((await api(origin, `/api/tasks/${first.data.taskId}`, { cookie: other })).status, 404);
  const version = await api(origin, `/api/projects/${id}/versions/${version1}`, { cookie });
  assert.equal(version.status, 200);
  assert.match(version.data.version.html, /result-2/);
  assert.equal((await api(origin, `/api/projects/${id}/versions/${version1}`, { cookie: other })).status, 404);

  requests = [];
  mode = "provider";
  const failed = await submit("加上每周提示");
  assert.equal(failed.status, 502);
  assert.equal(failed.data.errorCode, "MODEL");
  assert.equal((await api(origin, `/api/tasks/${failed.data.taskId}`, { cookie })).data.task.errorCode, "MODEL");
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie })).data.project.currentVersionId, version1);
  mode = "success";
  requests = [];
  const retry = await submit("加上每周提示", randomUUID(), { retryOfId: failed.data.taskId });
  assert.equal(retry.status, 201);
  assert.equal((await api(origin, `/api/tasks/${retry.data.taskId}`, { cookie })).data.task.retryOfId, failed.data.taskId);
  assert.match(requests[0].messages[1].content, /result-2/);
  assert.equal((await submit("wrong retry", randomUUID(), { retryOfId: first.data.taskId })).status, 400);

  requests = [];
  mode = "bad";
  const malformed = await submit("malformed");
  assert.equal(malformed.data.errorCode, "FORMAT");
  assert.equal(requests.length, 2, "at most one repair");
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie })).data.project.currentVersionId, retry.data.versionId);

  requests = [];
  mode = "repair";
  const repaired = await submit("format repair");
  assert.equal(repaired.status, 201);
  assert.equal(requests.length, 3);
  assert.match((await api(origin, `/api/projects/${id}/versions/${repaired.data.versionId}`, { cookie })).data.version.html, /repaired/);
  requests = [];
  mode = "unsafe";
  const unsafe = await submit("unsafe");
  assert.equal(unsafe.data.errorCode, "FORMAT");
  assert.equal(requests.length, 3);
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie })).data.project.currentVersionId, repaired.data.versionId);
  requests = [];
  mode = "network";
  const network = await submit("network");
  assert.equal(network.data.errorCode, "NETWORK");
  requests = [];
  mode = "timeout";
  const timeout = await submit("timeout");
  assert.equal(timeout.status, 504);
  assert.equal(timeout.data.errorCode, "TIMEOUT");

  requests = [];
  mode = "hold";
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  hold = started;
  const runningKey = randomUUID();
  const running = submit("blocked", runningKey);
  await pending;
  const state = await database.query("SELECT id, base_version_id, stage FROM tasks WHERE project_id = $1 AND status = 'running'", [id]);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].base_version_id, repaired.data.versionId);
  assert.equal(state.rows[0].stage, "planning");
  assert.equal((await submit("another")).status, 409);
  const repeated = await submit("blocked", runningKey);
  assert.equal(repeated.status, 202);
  assert.equal(repeated.data.task.id, state.rows[0].id);
  released();
  assert.equal((await running).status, 201);
  assert.equal((await api(origin, `/api/projects/${id}/versions`, { cookie })).data.versions.length, 4);

  requests = [];
  mode = "success";
  await database.query(`CREATE OR REPLACE FUNCTION fail_version() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated storage failure'; END $$`);
  await database.query("CREATE TRIGGER fail_version BEFORE INSERT ON versions FOR EACH ROW EXECUTE FUNCTION fail_version()");
  const prior = (await api(origin, `/api/projects/${id}`, { cookie })).data.project.currentVersionId;
  const storage = await submit("storage fail");
  assert.equal(storage.status, 503);
  assert.equal(storage.data.errorCode, "STORAGE");
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie })).data.project.currentVersionId, prior);
  await database.query("DROP TRIGGER fail_version ON versions");
  const afterFailure = await api(origin, `/api/projects/${id}/messages`, { cookie });
  assert.ok(afterFailure.data.messages.some((m) => m.taskId === storage.data.taskId && m.role === "user"));
  assert.ok(!afterFailure.data.messages.some((m) => m.taskId === storage.data.taskId && m.role === "assistant"));

  await database.query(
    `INSERT INTO tasks(id, project_id, base_version_id, status, stage, idempotency_key, deadline_at)
     VALUES ($1, $2, $3, 'running', 'planning', $4, now() - interval '1 second')`,
    [randomUUID(), id, prior, randomUUID()],
  );
  const stale = (await database.query("SELECT id FROM tasks WHERE project_id = $1 AND status = 'running'", [id])).rows[0].id;
  assert.equal((await api(origin, `/api/tasks/${stale}`, { cookie })).data.task.errorCode, "TIMEOUT");
  await stop(app);
  app = await start(isolated.toString(), `http://127.0.0.1:${modelPort}`);
  origin = app.origin;
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie })).data.project.currentVersionId, prior);
  assert.equal((await api(origin, `/api/projects/${id}/versions`, { cookie })).data.versions.length, 4);
  assert.equal((await api(origin, `/api/projects/${id}/messages`, { cookie })).data.messages.length, 14);

  await stop(app);
  app = await start(isolated.toString(), `http://127.0.0.1:${modelPort}`, { MODEL_API_KEY: "" });
  origin = app.origin;
  const configFailure = await api(origin, path, {
    cookie, method: "POST", key: randomUUID(), body: { prompt: "模型配置不可用" },
  });
  assert.equal(configFailure.status, 502);
  assert.equal(configFailure.data.errorCode, "MODEL");
  assert.equal(configFailure.data.retryable, false);
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie })).data.project.currentVersionId, prior);
});
