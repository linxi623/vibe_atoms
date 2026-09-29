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
const databaseName = `vibe_f_test_${randomBytes(6).toString("hex")}`;
const nextCli = "node_modules/next/dist/bin/next";
const html = "<!doctype html><html><head><title>Demo</title></head><body><button id='go'>Go</button><script>document.getElementById('go').onclick=()=>{};</script></body></html>";
let mode = "success";
let started;
let release;
let calls = 0;

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

async function start(databaseUrl, modelUrl, extra = {}) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [nextCli, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: origin, MODEL_BASE_URL: modelUrl,
      MODEL_API_KEY: "secret-do-not-expose", MODEL_NAME: "mock", TRUST_PROXY_IP: "true",
      IP_HASH_SECRET: "fixed-local-test-secret-32-characters",
      LIMIT_SESSION_PER_HOUR: "3", LIMIT_WRITE_PER_MINUTE: "30",
      LIMIT_IP_WRITE_PER_MINUTE: "30", LIMIT_GENERATION_PER_SESSION_HOUR: "3",
      LIMIT_GENERATION_PER_SESSION_DAY: "3", LIMIT_GENERATION_PER_IP_HOUR: "3",
      LIMIT_GENERATION_PER_IP_DAY: "3", LIMIT_GENERATION_PER_PROJECT_HOUR: "3",
      LIMIT_GLOBAL_CONCURRENCY: "1", LIMIT_TOTAL_TASKS: "2",
      MODEL_REQUEST_TIMEOUT_MS: "300", ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Next exited:\n${output}`);
    try {
      if ([200, 503].includes((await fetch(`${origin}/api/health`)).status)) {
        return { child, origin, output: () => output };
      }
    } catch { /* waiting */ }
    await delay(100);
  }
  child.kill();
  throw new Error(`Next did not start:\n${output}`);
}

async function stop(app) {
  if (app?.child.exitCode === null) {
    app.child.kill();
    await once(app.child, "exit");
  }
}

async function api(origin, path, { cookie, method = "GET", body, key, ip = "192.0.2.1", headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      "X-Forwarded-For": ip, ...(cookie ? { Cookie: cookie } : {}),
      ...(method === "GET" ? {} : { Origin: origin }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}), ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(!text.includes("secret-do-not-expose"));
  return { status: response.status, data: JSON.parse(text), headers: response.headers };
}

test("F: shared limits, idempotency, budget, headers, health and redaction", { timeout: 120000 }, async (t) => {
  assert.ok(adminUrl, "DATABASE_URL must point to PostgreSQL");
  const isolated = new URL(adminUrl);
  isolated.pathname = `/${databaseName}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let created = false;
  let app;
  let model;
  const database = new pg.Client({ connectionString: isolated.toString() });
  t.after(async () => {
    release?.();
    await stop(app);
    await new Promise((resolve) => model?.close(resolve) ?? resolve());
    await database.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await command(["scripts/migrate.mjs"], { DATABASE_URL: isolated.toString() });
  await database.connect();

  model = http.createServer(async (req, res) => {
    calls++;
    if (mode === "hold") {
      started?.();
      await new Promise((resolve) => { release = resolve; });
    }
    if (mode === "timeout") return;
    const content = calls % 2 ? JSON.stringify({ summary: "Plan", requirements: [], interactions: [] })
      : JSON.stringify({ html, summary: "Done" });
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const modelPort = await freePort();
  await new Promise((resolve) => model.listen(modelPort, "127.0.0.1", resolve));
  app = await start(isolated.toString(), `http://127.0.0.1:${modelPort}`);
  let { origin } = app;

  const health = await api(origin, "/api/health");
  assert.equal(health.data.status, "ok");
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("x-frame-options"), "DENY");
  assert.match(health.headers.get("content-security-policy"), /frame-src 'none'/);
  assert.equal((await fetch(origin)).headers.get("referrer-policy"), "no-referrer");
  assert.equal((await api(origin, "/api/session", { method: "POST", headers: { Origin: "https://foreign.invalid" } })).status, 403);

  const sessions = [];
  for (let i = 0; i < 3; i++) {
    const result = await api(origin, "/api/session", { method: "POST" });
    assert.equal(result.status, 201);
    sessions.push(result.headers.get("set-cookie").split(";")[0]);
  }
  assert.equal((await api(origin, "/api/session", { method: "POST" })).status, 429);
  const fourth = await api(origin, "/api/session", { method: "POST", ip: "192.0.2.2" });
  assert.equal(fourth.status, 201);
  const cookie = sessions[0];
  const otherCookie = fourth.headers.get("set-cookie").split(";")[0];
  assert.equal((await api(origin, "/api/projects", {
    method: "POST", cookie, body: { name: "x".repeat(20_000) },
  })).status, 413);
  assert.equal((await api(origin, "/api/projects", {
    method: "POST", cookie, body: { name: "Safe" }, headers: { Origin: "https://foreign.invalid" },
  })).status, 403);
  const project = await api(origin, "/api/projects", { method: "POST", cookie, body: { name: "A" } });
  const second = await api(origin, "/api/projects", { method: "POST", cookie: otherCookie, ip: "192.0.2.2", body: { name: "B" } });
  const id = project.data.project.id;
  const otherId = second.data.project.id;
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie: otherCookie, ip: "192.0.2.2" })).status, 404);
  const submit = (projectId, sessionCookie, ip, prompt, key = randomUUID()) =>
    api(origin, `/api/projects/${projectId}/generate`, { method: "POST", cookie: sessionCookie, ip, key, body: { prompt } });

  mode = "hold";
  const waiting = new Promise((resolve) => { started = resolve; });
  const firstKey = randomUUID();
  const pending = submit(id, cookie, "192.0.2.1", "First", firstKey);
  await waiting;
  const duplicate = await submit(id, cookie, "192.0.2.1", "First", firstKey);
  assert.equal(duplicate.status, 202);
  assert.equal((await submit(otherId, otherCookie, "192.0.2.2", "Parallel")).status, 429);
  assert.equal(Number((await database.query("SELECT count FROM platform_counters WHERE name = 'generation_tasks'")).rows[0].count), 1);
  mode = "success";
  release();
  assert.equal((await pending).status, 201);
  assert.equal((await submit(id, cookie, "192.0.2.1", "First", firstKey)).data.replayed, true);
  assert.equal((await submit(id, cookie, "192.0.2.1", "Different", firstKey)).status, 409);
  assert.equal((await api(origin, `/api/projects/${id}/versions`, { cookie })).data.versions.length, 1);

  mode = "timeout";
  const failed = await submit(otherId, otherCookie, "192.0.2.2", "Timeout");
  assert.equal(failed.status, 504);
  assert.equal(failed.data.errorCode, "TIMEOUT");
  assert.equal((await submit(id, cookie, "192.0.2.1", "Budget exhausted")).status, 429);
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie })).data.project.currentVersionId, (await api(origin, `/api/projects/${id}/versions`, { cookie })).data.versions[0].id);
  assert.equal((await database.query("SELECT count(*)::int AS count FROM tasks")).rows[0].count, 2);
  assert.equal((await database.query("SELECT count FROM platform_counters WHERE name = 'generation_tasks'")).rows[0].count, 2);
  assert.equal((await database.query("SELECT count(*)::int AS count FROM rate_limit_buckets WHERE key = '192.0.2.1'")).rows[0].count, 0);
  assert.ok(!app.output().includes("secret-do-not-expose"));

  await stop(app);
  app = await start(isolated.toString(), `http://127.0.0.1:${modelPort}`, {
    LIMIT_TOTAL_TASKS: "100", LIMIT_GENERATION_PER_PROJECT_HOUR: "1",
    LIMIT_GENERATION_PER_IP_HOUR: "100", LIMIT_GENERATION_PER_SESSION_HOUR: "100",
    LIMIT_WRITE_PER_MINUTE: "3", LIMIT_IP_WRITE_PER_MINUTE: "1",
  });
  origin = app.origin;
  assert.equal((await submit(id, cookie, "192.0.2.1", "Per-project cap")).status, 429);
  const freshProject = await api(origin, "/api/projects", {
    method: "POST", cookie: sessions[1], ip: "192.0.2.3", body: { name: "Fresh" },
  });
  assert.equal(freshProject.status, 201);
  assert.equal((await api(origin, "/api/projects", {
    method: "POST", cookie: sessions[1], ip: "192.0.2.3", body: { name: "Blocked IP write" },
  })).status, 429);
  assert.equal((await api(origin, "/api/projects", {
    method: "POST", cookie: sessions[1], ip: "192.0.2.4", body: { name: "Different IP" },
  })).status, 201);
  assert.equal((await api(origin, "/api/projects", {
    method: "POST", cookie: sessions[1], ip: "192.0.2.5", body: { name: "Session cap" },
  })).status, 201);
  assert.equal((await api(origin, "/api/projects", {
    method: "POST", cookie: sessions[1], ip: "192.0.2.6", body: { name: "Session cap again" },
  })).status, 429);
  assert.equal((await database.query("SELECT count FROM platform_counters WHERE name = 'generation_tasks'")).rows[0].count, 2);

  await stop(app);
  app = await start(isolated.toString(), `http://127.0.0.1:${modelPort}`, {
    LIMIT_TOTAL_TASKS: "100", LIMIT_GENERATION_PER_PROJECT_HOUR: "100",
    LIMIT_GENERATION_PER_IP_HOUR: "1", LIMIT_GENERATION_PER_SESSION_HOUR: "100",
    LIMIT_WRITE_PER_MINUTE: "100", LIMIT_IP_WRITE_PER_MINUTE: "100",
  });
  origin = app.origin;
  assert.equal((await submit(otherId, otherCookie, "192.0.2.2", "Per-IP cap")).status, 429);
  await stop(app);
  app = await start(isolated.toString(), `http://127.0.0.1:${modelPort}`, {
    LIMIT_TOTAL_TASKS: "100", LIMIT_GENERATION_PER_PROJECT_HOUR: "100",
    LIMIT_GENERATION_PER_IP_HOUR: "100", LIMIT_GENERATION_PER_SESSION_HOUR: "1",
    LIMIT_WRITE_PER_MINUTE: "100", LIMIT_IP_WRITE_PER_MINUTE: "100",
  });
  origin = app.origin;
  assert.equal((await submit(id, cookie, "192.0.2.3", "Per-session cap")).status, 429);
  await stop(app);
  calls = 0;
  mode = "success";
  app = await start(isolated.toString(), `http://127.0.0.1:${modelPort}`, {
    LIMIT_TOTAL_TASKS: "100", MODEL_TASK_TOKEN_BUDGET: "2000",
  });
  origin = app.origin;
  const budgetFailure = await submit(freshProject.data.project.id, sessions[1], "192.0.2.3", "Token budget");
  assert.equal(budgetFailure.status, 502);
  assert.equal(budgetFailure.data.errorCode, "MODEL");
  assert.equal(budgetFailure.data.retryable, false);
  assert.equal((await api(origin, `/api/projects/${id}/versions`, { cookie })).data.versions.length, 1);
  assert.equal(calls, 1);

  await stop(app);
  app = await start(isolated.toString(), "http://192.0.2.9", {
    LIMIT_TOTAL_TASKS: "100",
  });
  origin = app.origin;
  assert.equal((await api(origin, "/api/health")).status, 503);
  const insecureModel = await submit(freshProject.data.project.id, sessions[1], "192.0.2.3", "Reject HTTP model");
  assert.equal(insecureModel.status, 502);
  assert.equal(insecureModel.data.errorCode, "MODEL");
  assert.equal(insecureModel.data.retryable, false);
  assert.equal(calls, 1);

  await stop(app);
  app = await start(isolated.toString(), `http://127.0.0.1:${modelPort}`, { MODEL_API_KEY: "" });
  origin = app.origin;
  assert.equal((await api(origin, "/api/health")).status, 503);
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie })).status, 200);
  assert.equal((await api(origin, `/api/projects/${id}/versions`, { cookie })).data.versions.length, 1);
});
