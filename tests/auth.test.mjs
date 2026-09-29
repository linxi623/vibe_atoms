import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { chromium } from "playwright-core";

const adminUrl = process.env.DATABASE_URL;
const name = `vibe_auth_test_${randomBytes(6).toString("hex")}`;
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

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

async function start(databaseUrl) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      if ((await fetch(`${origin}/api/projects`)).status === 401) return { child, origin };
    } catch { /* Starting. */ }
    await delay(100);
  }
  child.kill();
  throw new Error(output);
}

async function api(origin, path, { cookie, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET" ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

test("accounts: register, migrate visitor projects, login on another device and revoke", { timeout: 90000 }, async (t) => {
  assert.ok(adminUrl, "DATABASE_URL required");
  const isolated = new URL(adminUrl);
  isolated.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let created = false;
  let app;
  let browser;
  t.after(async () => {
    await browser?.close();
    if (app?.child.exitCode === null) { app.child.kill(); await once(app.child, "exit"); }
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await command(["scripts/migrate.mjs"], { DATABASE_URL: isolated.toString() });
  app = await start(isolated.toString());
  const { origin } = app;
  const credentials = { email: "Person@Example.com", password: "correct horse battery staple" };

  const visitor = await api(origin, "/api/session", { method: "POST" });
  const guest = visitor.cookie;
  const project = await api(origin, "/api/projects", {
    cookie: guest, method: "POST", body: { name: "Before registration" },
  });
  assert.equal(project.status, 201);
  assert.equal((await api(origin, "/api/auth/register", {
    cookie: guest, method: "POST", body: credentials, headers: { Origin: "https://other.example" },
  })).status, 403);
  assert.equal((await api(origin, "/api/auth/register", {
    cookie: guest, method: "POST", body: { ...credentials, password: "short" },
  })).status, 400);
  const registered = await api(origin, "/api/auth/register", { cookie: guest, method: "POST", body: credentials });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.email, "person@example.com");
  assert.notEqual(registered.cookie, guest);
  assert.equal((await api(origin, "/api/projects", { cookie: guest })).status, 401);
  assert.equal((await api(origin, "/api/projects", { cookie: registered.cookie })).data.projects[0].id, project.data.project.id);
  assert.equal((await api(origin, "/api/auth", { cookie: registered.cookie })).data.email, "person@example.com");
  assert.equal((await api(origin, "/api/auth/register", { method: "POST", body: credentials })).status, 409);
  assert.equal((await api(origin, "/api/auth/login", {
    method: "POST", body: { ...credentials, password: "incorrect password" },
  })).status, 401);

  const secondVisitor = await api(origin, "/api/session", { method: "POST" });
  const secondProject = await api(origin, "/api/projects", {
    cookie: secondVisitor.cookie, method: "POST", body: { name: "From another device" },
  });
  const signedIn = await api(origin, "/api/auth/login", {
    cookie: secondVisitor.cookie, method: "POST",
    body: { email: "PERSON@example.com", password: credentials.password },
  });
  assert.equal(signedIn.status, 200);
  const projects = await api(origin, "/api/projects", { cookie: signedIn.cookie });
  assert.deepEqual(new Set(projects.data.projects.map((item) => item.id)),
    new Set([project.data.project.id, secondProject.data.project.id]));
  assert.equal((await api(origin, "/api/projects", { cookie: secondVisitor.cookie })).status, 401);
  assert.equal((await api(origin, "/api/projects", { cookie: registered.cookie })).data.projects.length, 2);
  assert.equal((await api(origin, "/api/auth", {
    cookie: signedIn.cookie, method: "DELETE", headers: { Origin: "https://other.example" },
  })).status, 403);
  assert.equal((await api(origin, "/api/auth", { cookie: signedIn.cookie, method: "DELETE" })).status, 200);
  assert.equal((await api(origin, "/api/projects", { cookie: signedIn.cookie })).status, 401);
  assert.equal((await api(origin, "/api/projects", { cookie: registered.cookie })).data.projects.length, 2);

  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "登录或注册" }).click();
  await page.getByRole("dialog", { name: "登录账户" }).getByLabel("邮箱").fill(credentials.email);
  await page.getByRole("dialog", { name: "登录账户" }).getByLabel("密码").fill(credentials.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "退出登录" }).waitFor();
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByRole("button", { name: "登录或注册" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "退出登录" }).count(), 0);
  const overflow = async () => page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    elements: [...document.querySelectorAll("body *")].filter((element) =>
      element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 8).map((element) => `${element.tagName}.${element.className}`),
  }));
  let sizing = await overflow();
  assert.equal(sizing.width <= sizing.viewport, true, JSON.stringify(sizing));
  await page.getByRole("tab", { name: "结果" }).click();
  sizing = await overflow();
  assert.equal(sizing.width <= sizing.viewport, true, JSON.stringify(sizing));

  const database = new pg.Client({ connectionString: isolated.toString() });
  await database.connect();
  try {
    const user = (await database.query("SELECT email, password_hash FROM users")).rows[0];
    assert.equal(user.email, "person@example.com");
    assert.ok(user.password_hash.startsWith("scrypt:"));
    assert.ok(!user.password_hash.includes(credentials.password));
    assert.equal((await database.query("SELECT count(*)::int AS count FROM account_sessions")).rows[0].count, 1);
  } finally {
    await database.end();
  }
});
