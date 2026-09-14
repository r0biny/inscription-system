import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readConfig } from "./lab_config.mjs";
import { proxyApi } from "./server.mjs";

const config = readConfig();
export default defineConfig({
  base: config.basePath + "/",
  plugins: [
    react(),
    {
      name: "lab-local-api",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith(config.basePath + "/api/")) return next();
          const address = server.httpServer?.address();
          const port = address && typeof address === "object" ? address.port : 5173;
          proxyApi(req, res, { ...config, publicOrigin: "http://127.0.0.1:" + port });
        });
      },
    },
  ],
  build: {
    // Build only this entry; no admin/debug or Cloudflare server bundles.
    outDir: "dist",
  },
});
