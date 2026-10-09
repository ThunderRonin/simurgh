import { readFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCoordinator, type CoordinatorOptions } from "./server";
import { codexAdapter, type CodexSettings } from "./codex";
import { localVoice, type VoiceSettings } from "./voice";
const configPath = process.env.SIMURGH_CONFIG;
if (!configPath)
  throw new Error(
    "SIMURGH_CONFIG must name a private local configuration file",
  );
const configStat = statSync(resolve(configPath));
if (
  (configStat.mode & 0o077) !== 0 ||
  (process.getuid && configStat.uid !== process.getuid())
)
  throw new Error("Configuration must be owner-only (0600)");
const config = JSON.parse(readFileSync(resolve(configPath), "utf8")) as Omit<
  CoordinatorOptions,
  "voice"
> & { codex?: CodexSettings; voice?: VoiceSettings };
mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
if (config.codex) config.agent = codexAdapter(config.codex);
const app = createCoordinator({
  ...config,
  voice: config.voice ? localVoice(config.voice) : undefined,
});
await app.listen(4317);
console.log("Simurgh coordinator listening at http://127.0.0.1:4317");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
