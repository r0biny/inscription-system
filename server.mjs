import http from "node:http";
import https from "node:https";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./lab_config.mjs";

const MAX_REQUEST_BYTES = 1_850_000; // Same limit as the existing Worker.
const UPSTREAM_COOKIE = "paper1_session";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };

function json(res, status, message) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok: false, message }));
}

export function upstreamCookie(header, config) {
  const cookie = (header || "").split(";").map((v) => v.trim()).find((v) => v.startsWith(config.cookieName + "="));
  return cookie ? UPSTREAM_COOKIE + cookie.slice(config.cookieName.length) : "";
}

export function browserCookie(cookie, config) {
  if (!cookie.startsWith(UPSTREAM_COOKIE + "=")) return null;
  return (config.cookieName + cookie.slice(UPSTREAM_COOKIE.length))
    .replace(/;\s*Domain=[^;]*/gi, "")
    .replace(/;\s*Path=[^;]*/gi, "; Path=" + config.basePath + "/");
}

export function proxyApi(req, res, config) {
  // Validate at the public boundary before translating Origin for the unchanged Worker.
  if (req.headers.origin && req.headers.origin !== config.publicOrigin) {
    json(res, 403, "请求来源无效。");
    req.resume();
    return;
  }
  const chunks = [];
  let size = 0;
  let rejected = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      if (!rejected) json(res, 413, "提交内容过大，请联系研究者。");
      rejected = true;
      chunks.length = 0;
      return;
    }
    if (!rejected) chunks.push(chunk);
  });
  req.on("error", () => { if (!res.writableEnded) res.destroy(); });
  req.on("end", () => {
    if (rejected) return;
    const suffix = req.url.slice(config.basePath.length);
    if (!suffix.startsWith("/api/")) return json(res, 404, "API 路径不存在。");
    const target = new URL(config.upstreamOrigin + suffix);
    const headers = { accept: "application/json", "accept-encoding": "identity" };
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];
    if (req.headers.origin) headers.origin = config.upstreamOrigin;
    const cookie = upstreamCookie(req.headers.cookie, config);
    if (cookie) headers.cookie = cookie;
    const body = Buffer.concat(chunks);
    if (body.length) headers["content-length"] = String(body.length);
    // No automatic retries: a timed-out POST may already have reached D1.
    const upstream = (target.protocol === "https:" ? https : http).request(target, {
      method: req.method, headers,
    }, (response) => {
      const outgoing = {
        "content-type": response.headers["content-type"] || "application/json; charset=utf-8",
        "cache-control": "no-store",
      };
      const cookies = (response.headers["set-cookie"] || []).map((c) => browserCookie(c, config)).filter(Boolean);
      if (cookies.length) outgoing["set-cookie"] = cookies;
      if (response.headers.location) {
        const redirect = new URL(response.headers.location, target);
        if (redirect.origin !== target.origin) {
          response.resume();
          return json(res, 502, "实验服务返回了意外跳转，请联系研究者。");
        }
        outgoing.location = config.basePath + redirect.pathname + redirect.search;
      }
      res.writeHead(response.statusCode || 502, outgoing);
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    const timeout = setTimeout(() => upstream.destroy(new Error("UPSTREAM_TIMEOUT")), 30_000);
    timeout.unref();
    upstream.on("close", () => clearTimeout(timeout));
    upstream.on("error", (error) => {
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) return res.destroy();
      json(res, error.message === "UPSTREAM_TIMEOUT" ? 504 : 502, "实验服务暂时无法连接，已保存的本地草稿会保留，请稍后重试。");
    });
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end(body);
  });
}

export function createAppServer(config, distRoot = fileURLToPath(new URL("./dist", import.meta.url))) {
  const root = path.resolve(distRoot);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://lab.invalid");
      if (url.pathname === config.basePath) {
        res.writeHead(308, { location: config.basePath + "/" + url.search });
        return res.end();
      }
      if (!url.pathname.startsWith(config.basePath + "/")) return json(res, 404, "页面不存在。");
      if (url.pathname.startsWith(config.basePath + "/api/")) return proxyApi(req, res, config);
      if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, "不支持的请求方式。");
      const relative = decodeURIComponent(url.pathname.slice(config.basePath.length + 1)) || "index.html";
      if (relative.split("/").some((s) => s.startsWith(".") || s.includes("\\"))) return json(res, 404, "页面不存在。");
      const file = path.resolve(root, relative);
      const type = TYPES[path.extname(file)];
      if (!file.startsWith(root + path.sep) || !type) return json(res, 404, "文件不存在。");
      const info = await stat(file);
      if (!info.isFile()) return json(res, 404, "文件不存在。");
      res.writeHead(200, {
        "content-type": type,
        "content-length": info.size,
        "cache-control": relative.startsWith("assets/") || (relative.startsWith("study-data/") && /^[a-f0-9]{12,64}$/.test(url.searchParams.get("v") || ""))
          ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      });
      if (req.method === "HEAD") return res.end();
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      if (!res.headersSent) json(res, error.code === "ENOENT" || error instanceof URIError ? 404 : 500, "文件暂时无法读取。");
      else res.destroy();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig();
  const built = JSON.parse(readFileSync(new URL("./dist/build_info.json", import.meta.url), "utf8"));
  if (built.basePath !== config.basePath) throw new Error("Deployment path changed. Run npm run build before restarting.");
  const server = createAppServer(config);
  server.listen(config.port, config.host, () => {
    console.log("Lab site: " + config.publicUrl + "/");
    console.log("Local listener: http://" + config.host + ":" + config.port + config.basePath + "/");
  });
}
