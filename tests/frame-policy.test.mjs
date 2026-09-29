import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { chromium } from "playwright-core";

const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("parent frame-src blocks preview self-navigation before network", async (t) => {
  const hits = [];
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "frame-src 'none'",
      });
      response.end(`<iframe sandbox="allow-scripts" srcdoc="<button id='test'>Run</button><script>document.getElementById('test').onclick=()=>document.body.dataset.clicked='yes'</script>"></iframe>`);
    } else {
      if (request.url !== "/favicon.ico") hits.push(request.url);
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("network hit");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
  t.after(async () => {
    await browser.close();
    server.close();
    await once(server, "close");
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const frame = page.frameLocator("iframe");
  await frame.locator("#test").click();
  assert.equal(await frame.locator("body").getAttribute("data-clicked"), "yes");
  await frame.locator("body").evaluate((body, target) => {
    body.ownerDocument.defaultView.location.href = target;
  }, `${origin}/leak`);
  await page.waitForTimeout(300);
  assert.deepEqual(hits, []);
});
