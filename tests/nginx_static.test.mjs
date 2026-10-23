import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startNginxFixture } from './fixtures/nginx_static.mjs';
import { readConfig } from '../lab_config.mjs';

test('Nginx-only deployment preserves study API, cookies, static scope and existing site', { skip: !process.env.NGINX_BINARY }, async t => {
  const requests = [];
  const held = [];
  const worker = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString(), method: req.method });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/hold') { held.push(res); return; }
    if (req.url === '/api/login') res.setHeader('set-cookie', 'paper1_session=abc; Domain=worker.invalid; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000');
    if (req.url === '/api/logout') res.setHeader('set-cookie', 'paper1_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    if (req.url === '/api/unrelated-cookie') res.setHeader('set-cookie', 'unrelated=private; Path=/');
    if (req.url === '/api/conflict') { res.writeHead(409); return res.end('{"ok":false,"error":"revision_conflict"}'); }
    if (req.url === '/api/redirect') { res.writeHead(307, { location: workerOrigin + '/api/status?x=1' }); return res.end(); }
    if (req.url === '/api/external-redirect') { res.writeHead(302, { location: 'https://other.invalid/' }); return res.end(); }
    res.end('{"ok":true,"databaseReady":true}');
  });
  await new Promise(resolve => worker.listen(0, '127.0.0.1', resolve));
  t.after(async () => { worker.closeAllConnections(); await new Promise(resolve => worker.close(resolve)); });
  const workerOrigin = 'http://127.0.0.1:' + worker.address().port;
  const config = { ...readConfig(), upstreamOrigin: workerOrigin };
  const lab = await startNginxFixture(config);
  const base = lab.base.slice(0, -1);
  t.after(async () => { await lab.close(); });

  await t.test('static files, caching, subdirectory redirect and main site remain correct', async () => {
    const redirect = await fetch(base + '?a=1', { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(new URL(redirect.headers.get('location'), lab.origin).pathname, config.basePath + '/');
    assert.equal(new URL(redirect.headers.get('location'), lab.origin).search, '?a=1');
    const html = await fetch(lab.base);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /\/inscription-system\/assets\//);
    assert.equal((await fetch(lab.origin)).status, 200);
    assert.equal((await fetch(base + '/build_info.json')).status, 404);
    assert.equal((await fetch(base + '/.git/config')).status, 404);
    const photo = await fetch(base + '/study-data/home-covers/practice.jpg?v=abcdef123456');
    assert.equal(photo.status, 200);
    assert.match(photo.headers.get('cache-control'), /immutable/);
    assert.equal((await fetch(base + '/study-data/home-covers/practice.jpg')).headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(base + '/offline_sw.js')).headers.get('cache-control'), 'no-cache');
    assert.equal(requests.length, 0);
  });
  await t.test('login/logout cookies preserve flags, remove Domain, and stay inside study', async () => {
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { origin: lab.origin, cookie: 'unrelated=secret; paper1_session=other' }, body: '{}' });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('set-cookie'), config.cookieName + '=abc; Path=' + config.basePath + '/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000');
    assert.equal(login.headers.get('cache-control'), 'no-store');
    assert.equal(requests.at(-1).headers.cookie, undefined);
    assert.equal(requests.at(-1).headers.origin, workerOrigin);
    const logout = await fetch(base + '/api/logout', { method: 'POST', body: '{}' });
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.ok(logout.headers.get('set-cookie').startsWith(config.cookieName + '=;'));
    assert.equal((await fetch(base + '/api/unrelated-cookie')).headers.get('set-cookie'), null);
  });
  await t.test('Origin rejection, exact body/query forwarding, isolated request headers', async () => {
    const count = requests.length;
    assert.equal((await fetch(base + '/api/login', { method: 'POST', headers: { origin: 'https://other.invalid' }, body: '{}' })).status, 403);
    assert.equal(requests.length, count);
    const body = JSON.stringify({ text: '测试 /study-data/preserve', padding: 'x'.repeat(1_600_000) });
    for (const route of ['task/save', 'session/pause', 'session/resume', 'session/heartbeat', 'task/complete', 'practice/complete', 'offline/sync', 'feedback']) {
      const response = await fetch(base + '/api/' + route + '?x=a%2Fb', { method: 'POST', headers: { origin: lab.origin, 'content-type': 'application/json', authorization: 'private', cookie: config.cookieName + '=abc; unrelated=private' }, body });
      assert.equal(response.status, 200);
      assert.equal(requests.at(-1).body, body);
      assert.equal(requests.at(-1).url, '/api/' + route + '?x=a%2Fb');
      assert.equal(requests.at(-1).headers.cookie, 'paper1_session=abc');
      assert.equal(requests.at(-1).headers.authorization, undefined);
    }
    assert.doesNotMatch(await lab.logs(), /buffered to a temporary file/);
  });
  await t.test('oversize request, upstream errors and safe redirects', async () => {
    const count = requests.length;
    assert.equal((await fetch(base + '/api/task/save', { method: 'POST', body: 'x'.repeat(1_850_001) })).status, 413);
    assert.equal(requests.length, count);
    const conflict = await fetch(base + '/api/conflict');
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { ok: false, error: 'revision_conflict' });
    const redirect = await fetch(base + '/api/redirect', { redirect: 'manual' });
    assert.equal(redirect.status, 307);
    assert.equal(new URL(redirect.headers.get('location'), lab.origin).pathname, config.basePath + '/api/status');
    assert.equal((await fetch(base + '/api/external-redirect', { redirect: 'manual' })).status, 502);
  });
  await t.test('API concurrency is bounded without sending excess requests upstream', async () => {
    const pending = Array.from({ length: 8 }, () => fetch(base + '/api/hold').then(r => r.text()));
    try {
      for (let i = 0; i < 100 && held.length < 8; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(held.length, 8);
      assert.equal((await fetch(base + '/api/status')).status, 429);
    } finally {
      for (const response of held) response.end('{"ok":true}');
      await Promise.all(pending);
    }
  });
});
