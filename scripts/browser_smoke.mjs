// Optional browser check: uses only a local mock Worker, never writes to D1.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createAppServer } from "../server.mjs";
import { readConfig } from "../lab_config.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + server.address().port;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const home = {
  ok: true, status: "home", participantId: "P00001", sessionId: "lab-browser-test",
  caseSetId: "case_balanced_gaussian_v1", pausedAt: null, pausedTotalMs: 0,
  practice: { completed: false, completedAt: null, version: 0, currentVersion: 1 },
  progress: { completed: 0, total: 3 }, allCompleted: false, canStartAnotherRun: false,
  tutorialAuthoring: null, history: [],
  tasks: [1, 2, 3].map((order) => ({
    taskOrder: order, uiStatus: "locked", caseId: null, condition: null,
    coverImageUrl: "/study-data/home-covers/cover_0" + order + ".jpg",
    stage: null, completedAt: null, preloadImageUrl: "",
  })),
};
const upstreamRequests = [];
const upstream = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume body */ }
  upstreamRequests.push(req.url);
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/status") return res.end(JSON.stringify({ ok: true, databaseReady: true, isOpen: true, canCreateSession: true }));
  if (req.url === "/api/participant/start") {
    res.setHeader("set-cookie", "paper1_session=browser-test; Path=/; HttpOnly; Secure; SameSite=Lax");
    return res.end(JSON.stringify(home));
  }
  if (req.url === "/api/participant/logout") {
    res.setHeader("set-cookie", "paper1_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    return res.end('{"ok":true}');
  }
  if (req.url === "/api/participant/session") {
    return res.end(JSON.stringify(req.headers.cookie?.includes("paper1_session=browser-test") ? home : { ok: true, status: "anonymous" }));
  }
  res.writeHead(404);
  res.end('{"ok":false}');
});
const upstreamOrigin = await listen(upstream);
const config = { ...readConfig(), upstreamOrigin };
const built = JSON.parse(await readFile(new URL("../dist/build_info.json", import.meta.url)));
assert.equal(config.basePath, built.basePath);
const lab = createAppServer(config);
const labOrigin = await listen(lab);
config.publicOrigin = labOrigin;
let browser;
try {
  browser = await chromium.launch({
    headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  const wrongRequests = [];
  const failedResponses = [];
  const loadedImages = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) &&
        (url.origin !== labOrigin || (url.pathname !== config.basePath && !url.pathname.startsWith(config.basePath + "/")))) wrongRequests.push(request.url());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(response.url());
    if (response.status() === 200 && response.url().includes("/study-data/")) loadedImages.push(response.url());
  });
  await page.goto(labOrigin + config.basePath, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "查看参与说明" }).click();
  await page.locator('input[type="email"]').fill("test@example.invalid");
  await page.locator("#identity-consent").check();
  await page.getByRole("button", { name: "进入 Dashboard" }).click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  await page.waitForFunction(() => [...document.images].length >= 4 && [...document.images].every((image) => image.complete && image.naturalWidth > 0));
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: process.env.SCREENSHOT_DIR + "/lab_dashboard.png", fullPage: true });
  const cookies = await page.context().cookies();
  assert.ok(cookies.some((c) => c.name === config.cookieName && c.path === config.basePath + "/"));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  await page.getByRole("button", { name: "开始新手引导" }).click();
  await page.getByRole("navigation", { name: "任务进度" }).waitFor();
  await page.waitForFunction(() => !!document.querySelector(".openseadragon-canvas canvas"));
  // The Dashboard may have preloaded this image before the practice is opened.
  assert.ok(loadedImages.some((url) => url.includes("/study-data/practice/case/pages/")));
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: process.env.SCREENSHOT_DIR + "/lab_practice.png", fullPage: true });
  await page.getByRole("button", { name: "关闭本步骤引导" }).click();
  await page.getByRole("button", { name: "返回 Dashboard" }).click();
  await page.getByRole("button", { name: "退出当前身份" }).click();
  await page.getByRole("button", { name: "查看参与说明" }).waitFor();
  assert.equal((await page.context().cookies()).filter((c) => c.name === config.cookieName).length, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(wrongRequests, []);
  assert.deepEqual(failedResponses, []);
  assert.ok(upstreamRequests.includes("/api/participant/start"));
  assert.ok(upstreamRequests.includes("/api/participant/logout"));
  console.log("Browser smoke passed: welcome, login, local covers, cookie reload, practice/OpenSeadragon and logout.");
} finally {
  if (browser) await browser.close();
  await close(lab);
  await close(upstream);
}
