import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createCoordinator,
  type CoordinatorOptions,
  type TelemetryPolicy,
} from "../../packages/coordinator/src/server";
import { codexAdapter, type CodexSettings } from "../../packages/coordinator/src/codex";

type LiveConfig = {
  codex?: CodexSettings;
  telemetry?: TelemetryPolicy;
  limits?: CoordinatorOptions["limits"];
  sessionMs?: number;
};

const [stateDirectory, workspaceDist, configPath, resultPath] = process.argv.slice(2);
if (!stateDirectory || !workspaceDist || !configPath || !resultPath)
  throw new Error("Live workspace server arguments are required");

const configStat = statSync(configPath);
if (
  (configStat.mode & 0o077) !== 0 ||
  (process.getuid && configStat.uid !== process.getuid())
)
  throw new Error("Coordinator configuration must be owner-only and owned by this user");
const config = JSON.parse(readFileSync(configPath, "utf8")) as LiveConfig;
if (!config.codex || !config.telemetry)
  throw new Error("Live workspace verification requires Codex and telemetry configuration");

mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
const stateStat = statSync(stateDirectory);
if (
  (stateStat.mode & 0o077) !== 0 ||
  (process.getuid && stateStat.uid !== process.getuid())
)
  throw new Error("Live workspace state directory must be owner-only");

const reservation = createServer();
await new Promise<void>((resolveListen, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolveListen);
});
const address = reservation.address();
if (!address || typeof address === "string")
  throw new Error("Could not reserve a loopback port");
const port = address.port;
await new Promise<void>((resolveClose, reject) =>
  reservation.close((error) => error ? reject(error) : resolveClose()),
);

const token = randomBytes(32).toString("base64url");
const viewerToken = randomBytes(32).toString("base64url");
const app = createCoordinator({
  databasePath: resolve(stateDirectory, "workspace.sqlite"),
  origin: `http://127.0.0.1:${port}`,
  workspaceDist: resolve(workspaceDist),
  users: [
    { id: "live-owner", name: "Live workspace owner", token },
    { id: "live-viewer", name: "Live workspace viewer", token: viewerToken },
  ],
  limits: config.limits,
  sessionMs: config.sessionMs,
  telemetry: config.telemetry,
  agent: codexAdapter(config.codex),
});

await app.listen(port);
writeFileSync(
  resultPath,
  JSON.stringify({ url: app.url, token, viewerToken }),
  { mode: 0o600, flag: "wx" },
);
process.stdout.write("READY\n");

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().finally(() => process.exit(0));
  });

