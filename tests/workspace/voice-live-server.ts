import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createCoordinator } from "../../packages/coordinator/src/server";
import { localVoice } from "../../packages/coordinator/src/voice";

const [stateDirectory, workspaceDist, image, modelDirectory, resultPath] =
  process.argv.slice(2);
if (!stateDirectory || !workspaceDist || !image || !modelDirectory || !resultPath)
  throw new Error("Voice live test server arguments are required");
mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

const reservation = createServer();
await new Promise<void>((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const address = reservation.address();
if (!address || typeof address === "string") throw new Error("Could not reserve local test port");
const port = address.port;
await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

const token = randomBytes(32).toString("base64url");
const viewerToken = randomBytes(32).toString("base64url");
const app = createCoordinator({
  databasePath: `${stateDirectory}/workspace.sqlite`,
  origin: `http://127.0.0.1:${port}`,
  workspaceDist,
  users: [
    { id: "voice-test-user", name: "Local voice test", token },
    { id: "voice-test-viewer", name: "Local voice viewer", token: viewerToken },
  ],
  voice: localVoice({ image, modelDirectory }),
  agent: {
    async run(input) {
      const evidence = await input.read(input.references[0].id, "selected");
      return {
        strength: "hypothesis",
        summary: "A local test finding for speech playback.",
        citations: [evidence.id],
        limitations: ["Synthetic test-only finding; no real model inference."],
        nextCheck: "Collect profiles",
      };
    },
  },
});
await app.listen(port);
writeFileSync(resultPath, JSON.stringify({ url: app.url, token, viewerToken }), { mode: 0o600, flag: "wx" });
process.stdout.write("READY\n");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void app.close().finally(() => process.exit(0)));
}
