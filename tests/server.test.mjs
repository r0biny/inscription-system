import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppServer } from "../server.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test("lab local server preserves Worker API semantics and isolates subdirectory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "inscription-lab-test-"));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, method: req.method, body: Buffer.concat(chunks).toString() });
    if (req.url === "/api/failure") {
      res.writeHead(409, { "content-type": "application/json" });
      return res.end('{"ok":false,"error":"revision_conflict"}');
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/participant/start") res.setHeader("set-cookie", "paper1_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
    if (req.url === "/api/participant/logout") res.setHeader("set-cookie", "paper1_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    res.end('{"ok":true,"databaseReady":true}');
  });
  const upstreamOrigin = await listen(upstream);
  const config = { basePath: "/inscription-system", publicOrigin: "https://www.musicxlab.com", upstreamOrigin, cookieName: "inscription_lab_test" };
  await mkdir(path.join(root, "study-data"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<h1>Study</h1>");
  await writeFile(path.join(root, "study-data", "page.jpg"), "local-image");
  const lab = createAppServer(config, root);
  const origin = await listen(lab);
  const base = origin + config.basePath;
  t.after(async () => { await close(lab); await close(upstream); await rm(root, { recursive: true, force: true }); });

  await t.test("redirect and local images stay in subdirectory, unrelated pages are not served", async () => {
    const redirect = await fetch(base + "?x=1", { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/inscription-system/?x=1");
    assert.equal(await (await fetch(base + "/")).text(), "<h1>Study</h1>");
    assert.equal(await (await fetch(base + "/study-data/page.jpg?v=abc")).text(), "local-image");
    assert.equal(requests.length, 0);
    assert.equal((await fetch(origin + "/")).status, 404);
    assert.equal((await fetch(origin + "/api/status")).status, 404);
    assert.equal((await fetch(base + "/missing.jpg")).status, 404);
    assert.equal((await fetch(base + "/.env")).status, 404);
  });
  await t.test("login rewrites only this app's cookie and validates Origin", async () => {
    const response = await fetch(base + "/api/participant/start", {
      method: "POST", headers: { origin: config.publicOrigin, "content-type": "application/json", cookie: "lab_account=private; paper1_session=unrelated" },
      body: '{"email":"test@example.invalid","acceptedRules":true}',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("set-cookie"), /^inscription_lab_test=abc;/);
    assert.match(response.headers.get("set-cookie"), /Path=\/inscription-system\//);
    assert.match(response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
    assert.equal(requests.at(-1).headers.origin, upstreamOrigin);
    assert.equal(requests.at(-1).headers.cookie, undefined);
    const count = requests.length;
    assert.equal((await fetch(base + "/api/participant/start", { method: "POST", headers: { origin: "https://other.invalid" }, body: "{}" })).status, 403);
    assert.equal(requests.length, count);
  });
  await t.test("save, pause, resume, heartbeat, survey completion preserve bytes and query", async () => {
    const entry = JSON.stringify({ taskId: "task-1", revision: 7, entry: { answers: [{ strokes: [{ x: 0.3, y: 0.7, pointerType: "pen" }] }], survey: { answer: "测试" }, padding: "x".repeat(1_100_000) } });
    for (const route of ["task/save", "session/pause", "session/resume", "session/heartbeat", "task/complete", "practice/complete", "feedback"]) {
      const response = await fetch(base + "/api/" + route + "?v=1", {
        method: "POST", headers: { origin: config.publicOrigin, "content-type": "application/json", cookie: "inscription_lab_test=abc; lab_account=secret" }, body: entry,
      });
      assert.equal(response.status, 200);
      assert.equal(requests.at(-1).url, "/api/" + route + "?v=1");
      assert.equal(requests.at(-1).headers.cookie, "paper1_session=abc");
      assert.equal(requests.at(-1).body, entry);
    }
  });
  await t.test("Worker error and logout semantics are retained; oversize payload is rejected once", async () => {
    const conflict = await fetch(base + "/api/failure");
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, "revision_conflict");
    const logout = await fetch(base + "/api/participant/logout", { method: "POST", body: "{}" });
    assert.match(logout.headers.get("set-cookie"), /inscription_lab_test=;/);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    const count = requests.length;
    assert.equal((await fetch(base + "/api/task/save", { method: "POST", body: "x".repeat(1_850_001) })).status, 413);
    assert.equal(requests.length, count);
  });
  await t.test("a new directory uses the same backend without swallowing another site", async () => {
    const alternate = createAppServer({ ...config, basePath: "/research/repair" }, root);
    const addr = await listen(alternate);
    try {
      assert.equal((await fetch(addr + "/research/repair/")).status, 200);
      assert.equal((await fetch(addr + "/research/repair/api/status")).status, 200);
      assert.equal((await fetch(addr + "/inscription-system/")).status, 404);
    } finally { await close(alternate); }
  });
});
