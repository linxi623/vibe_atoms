import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";

const adminUrl = process.env.DATABASE_URL;
const databaseName = `vibe_f1_test_${randomBytes(6).toString("hex")}`;
const nextCli = "node_modules/next/dist/bin/next";

async function command(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `${args.join(" ")} failed:\n${output}`);
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function startServer(databaseUrl) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [nextCli, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Next exited early:\n${output}`);
    try {
      const response = await fetch(`${origin}/api/projects`);
      if (response.status === 401) return { child, origin };
    } catch {
      // Wait for the listener to start.
    }
    await delay(100);
  }
  child.kill();
  throw new Error(`Next did not become ready:\n${output}`);
}

async function stopServer(child) {
  if (child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
}

async function api(origin, path, { cookie, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { Origin: origin } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") };
}

test("F1: isolated visitors, ownership, rename, refresh and server restart", { timeout: 90000 }, async (t) => {
  assert.ok(adminUrl, "Set DATABASE_URL to an existing PostgreSQL database for the isolated test database");
  const url = new URL(adminUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  let created = false;
  let server;
  t.after(async () => {
    if (server) await stopServer(server.child);
    if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await command(["scripts/migrate.mjs"], { DATABASE_URL: databaseUrl.toString() });
  server = await startServer(databaseUrl.toString());
  let { origin } = server;

  assert.equal((await api(origin, "/api/projects")).status, 401);
  assert.equal((await api(origin, "/api/session", { method: "POST", headers: { Origin: "https://foreign.example" } })).status, 403);
  const a = await api(origin, "/api/session", { method: "POST" });
  const b = await api(origin, "/api/session", { method: "POST" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const cookieA = a.cookie.split(";")[0];
  const cookieB = b.cookie.split(";")[0];
  assert.notEqual(cookieA, cookieB);
  assert.match(a.cookie, /HttpOnly/i);
  assert.match(a.cookie, /Secure/i);
  assert.match(a.cookie, /SameSite=lax/i);
  assert.equal((await api(origin, "/api/session", { cookie: cookieA, method: "POST" })).status, 200);
  assert.equal((await api(origin, "/api/projects", { cookie: "vibe_session=" + "0".repeat(64) })).status, 401);

  assert.equal((await api(origin, "/api/projects", { cookie: cookieA, method: "POST", body: { name: "No", visitorId: "forged" }, headers: { Origin: "https://foreign.example" } })).status, 403);
  for (const name of ["", " ".repeat(2), "x".repeat(81)]) {
    assert.equal((await api(origin, "/api/projects", { cookie: cookieA, method: "POST", body: { name } })).status, 400);
  }
  const first = await api(origin, "/api/projects", { cookie: cookieA, method: "POST", body: { name: "  First  ", visitorId: "forged" } });
  assert.equal(first.status, 201);
  assert.equal(first.data.project.name, "First");
  const id = first.data.project.id;
  assert.equal((await api(origin, `/api/projects/${id}`)).status, 401);
  assert.equal((await api(origin, "/api/projects", { cookie: cookieB })).data.projects.length, 0);
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie: cookieB })).status, 404);
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie: cookieB, method: "PATCH", body: { name: "Stolen" } })).status, 404);
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie: cookieA, method: "PATCH", body: { name: "Blocked" }, headers: { Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie: cookieA, method: "PATCH", body: { name: "" } })).status, 400);
  assert.equal((await api(origin, "/api/projects/not-a-uuid", { cookie: cookieA })).status, 404);
  assert.equal((await api(origin, "/api/projects/not-a-uuid", { cookie: cookieA, method: "PATCH", body: { name: "Nope" } })).status, 404);
  const renamed = await api(origin, `/api/projects/${id}`, { cookie: cookieA, method: "PATCH", body: { name: "  Renamed  " } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.project.name, "Renamed");
  assert.equal((await api(origin, "/api/projects", { cookie: cookieA })).data.projects[0].name, "Renamed");

  await stopServer(server.child);
  server = undefined;
  server = await startServer(databaseUrl.toString());
  origin = server.origin;
  assert.equal((await api(origin, "/api/session", { cookie: cookieA, method: "POST" })).status, 200);
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie: cookieA })).data.project.name, "Renamed");
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie: cookieB })).status, 404);
  const fresh = await api(origin, "/api/session", { method: "POST" });
  assert.equal(fresh.status, 201);
  assert.equal((await api(origin, "/api/projects", { cookie: fresh.cookie.split(";")[0] })).data.projects.length, 0);
  assert.equal((await api(origin, `/api/projects/${id}`, { cookie: fresh.cookie.split(";")[0] })).status, 404);

  const db = new pg.Client({ connectionString: databaseUrl.toString() });
  await db.connect();
  try {
    const rows = (await db.query("SELECT token_hash FROM visitors")).rows;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.token_hash) && ![cookieA, cookieB].some((cookie) => cookie.includes(row.token_hash))));
    assert.equal((await db.query("SELECT name FROM projects WHERE id = $1", [id])).rows[0].name, "Renamed");
  } finally {
    await db.end();
  }
});
