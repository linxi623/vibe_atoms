import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";

async function port() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  server.close();
  await once(server, "close");
  return value;
}

async function api(origin, path, cookie, method = "GET", body, key) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === "GET" ? {} : { Origin: origin }),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") };
}

test("B: non-sample real model generation and iteration", {
  skip: process.env.REAL_MODEL_TEST !== "1",
  timeout: 240000,
}, async (t) => {
  for (const variable of ["DATABASE_URL", "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL_NAME"]) {
    assert.ok(process.env[variable], `${variable} must be configured`);
  }
  const name = `vibe_real_test_${randomBytes(6).toString("hex")}`;
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  let created = false;
  let app;
  t.after(async () => {
    if (app && app.exitCode === null) {
      app.kill();
      await once(app, "exit");
    }
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const migration = spawn(process.execPath, ["scripts/migrate.mjs"], {
    env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
    stdio: "ignore",
  });
  assert.equal((await once(migration, "exit"))[0], 0, "migration failed");
  const listen = await port();
  const origin = `http://127.0.0.1:${listen}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(listen)], {
    env: { ...process.env, DATABASE_URL: databaseUrl.toString(), APP_ORIGIN: origin },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await api(origin, "/api/projects")).status === 401) break;
    } catch { /* wait */ }
    assert.equal(app.exitCode, null, "server exited before ready");
    await delay(100);
  }
  const session = await api(origin, "/api/session", null, "POST");
  assert.equal(session.status, 201);
  const cookie = session.cookie.split(";")[0];
  const project = await api(origin, "/api/projects", cookie, "POST", { name: "真实生成验收" });
  assert.equal(project.status, 201);
  const id = project.data.project.id;
  const prompt = "制作一个公交票价计算器：输入乘坐站数、选择成人或学生，展示票价与清晰的计价说明，提供重置按钮。";
  const first = await api(origin, `/api/projects/${id}/generate`, cookie, "POST", { prompt }, randomUUID());
  if (first.status !== 201) {
    const task = await api(origin, `/api/tasks/${first.data.taskId}`, cookie);
    assert.equal(first.status, 201, `first generation failed: ${first.data.errorCode ?? "unknown"}, stage=${task.data.task?.stage}, planned=${Boolean(task.data.task?.plan)}, detail=${task.data.task?.errorDetail}`);
  }
  const v1 = await api(origin, `/api/projects/${id}/versions/${first.data.versionId}`, cookie);
  assert.equal(v1.status, 200);
  assert.match(v1.data.version.html, /站|票价|fare|bus/i);
  assert.match(v1.data.version.html, /addEventListener/i);
  const second = await api(origin, `/api/projects/${id}/generate`, cookie, "POST", {
    prompt: "在原有站数和成人/学生票价计算功能基础上，增加夜间时段附加费选项，保留重置按钮。",
  }, randomUUID());
  assert.equal(second.status, 201, `iteration failed: ${second.data.errorCode ?? "unknown"}`);
  const v2 = await api(origin, `/api/projects/${id}/versions/${second.data.versionId}`, cookie);
  assert.equal(v2.status, 200);
  assert.notEqual(v1.data.version.html, v2.data.version.html);
  assert.match(v2.data.version.html, /夜间|night/i);
  assert.match(v2.data.version.html, /站|票价|fare|bus/i);
  const detail = await api(origin, `/api/projects/${id}`, cookie);
  const messages = await api(origin, `/api/projects/${id}/messages`, cookie);
  const versions = await api(origin, `/api/projects/${id}/versions`, cookie);
  assert.equal(detail.data.project.currentVersionId, second.data.versionId);
  assert.equal(messages.data.messages.length, 4);
  assert.equal(versions.data.versions.length, 2);
  console.log("Real model: two non-sample generations saved, distinct versions and persistent messages verified");
});
