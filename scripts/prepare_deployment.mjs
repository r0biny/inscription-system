import { readFile, writeFile } from "node:fs/promises";
import { readConfig } from "../lab_config.mjs";

const config = readConfig();
await writeFile(new URL("../dist/build_info.json", import.meta.url), JSON.stringify({
  basePath: config.basePath, builtAt: new Date().toISOString(),
}, null, 2) + "\n");
const nginx = [
  "# Paste these two locations INSIDE the existing HTTPS server block.",
  "# Keep the existing lab website locations and TLS configuration.",
  "location = " + config.basePath + " {",
  "    return 308 " + config.basePath + "/$is_args$args;",
  "}",
  "location ^~ " + config.basePath + "/ {",
  "    # No trailing slash: preserve the complete subdirectory path.",
  "    proxy_pass http://127.0.0.1:" + config.port + ";",
  "    proxy_http_version 1.1;",
  "    proxy_set_header Host $host;",
  "    proxy_set_header Connection \"\";",
  "    client_max_body_size 2m;",
  "    proxy_read_timeout 40s;",
  "    proxy_cache off;",
  "}",
  "",
].join("\n");
await writeFile(new URL("../deploy/nginx_locations.conf", import.meta.url), nginx);
// The browser bundle must never depend on the original monorepo.
const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
if (!html.includes(config.basePath + "/assets/")) throw new Error("Subdirectory build verification failed.");
console.log("Prepared lab build and deploy/nginx_locations.conf for " + config.publicUrl);
