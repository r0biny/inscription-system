import { spawnSync } from "node:child_process";
import { readConfig } from "../lab_config.mjs";

const config = readConfig();
let failed = false;
for (let i = 1; i <= 5; i++) {
  const result = spawnSync("curl", [
    "-4", "-sS", "--noproxy", "*", "--fail-with-body", "--connect-timeout", "8", "--max-time", "25",
    "-w", "\nhttp=%{http_code} total=%{time_total}s\n", config.upstreamOrigin + "/api/status",
  ], { encoding: "utf8" });
  console.log("Read-only status check " + i + "/5");
  console.log(result.stdout);
  if (result.status !== 0 || !result.stdout.includes('"databaseReady":true')) {
    failed = true;
    console.error(result.stderr || "Database status was not ready.");
  }
}
process.exitCode = failed ? 1 : 0;
