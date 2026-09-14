import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export function readConfig(env = process.env) {
  const saved = JSON.parse(readFileSync(new URL("./deployment.json", import.meta.url), "utf8"));
  const publicUrl = new URL(env.LAB_PUBLIC_URL || saved.publicUrl);
  const upstream = new URL(env.LAB_UPSTREAM_ORIGIN || saved.upstreamOrigin);
  const basePath = publicUrl.pathname.replace(/\/+$/, "") || "";
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(basePath) || basePath.includes("//")) {
    throw new Error("publicUrl must contain a subdirectory, for example /inscription-system");
  }
  for (const url of [publicUrl, upstream]) {
    if (url.username || url.password || url.search || url.hash) throw new Error("URLs must not contain credentials, query or hash.");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
      throw new Error("Use HTTPS, except for local development.");
    }
  }
  if (upstream.pathname !== "/") throw new Error("upstreamOrigin must be an origin without a path.");
  const port = Number(env.PORT || saved.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  return {
    publicUrl: publicUrl.origin + basePath, publicOrigin: publicUrl.origin,
    basePath, upstreamOrigin: upstream.origin,
    host: env.HOST || saved.host, port,
    cookieName: "inscription_lab_" + createHash("sha256").update(basePath).digest("hex").slice(0, 10),
  };
}
