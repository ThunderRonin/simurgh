import { it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { localVoice } from "../../packages/coordinator/src/voice";
it.skipIf(process.env.SIMURGH_VOICE_SETUP_VERIFY !== "1")(
  "optional setup is idempotent, preserves auth and uses private model/config files",
  async () => {
    const state = mkdtempSync(join(tmpdir(), "simurgh-voice-setup-"));
    const config = join(state, "coordinator.json");
    const models = join(state, "voice-models");
    mkdirSync(models, { mode: 0o700 });
    copyFileSync(
      resolve("work/ultracode/five-phase/voice/models/ggml-tiny.en.bin"),
      join(models, "ggml-tiny.en.bin"),
    );
    const users = [{ id: "alice", name: "Alice", tokenHash: "a".repeat(64) }];
    writeFileSync(
      config,
      JSON.stringify({
        origin: "http://127.0.0.1:4317",
        databasePath: join(state, "db"),
        users,
        marker: "Preserved",
      }),
      { mode: 0o600 },
    );
    try {
      for (let n = 0; n < 2; n++) {
        const result = spawnSync(
          process.execPath,
          ["scripts/setup-voice.mjs", config],
          { encoding: "utf8", timeout: 60000 },
        );
        expect(result.status, result.stderr).toBe(0);
        const current = JSON.parse(readFileSync(config, "utf8"));
        expect(current.users).toEqual(users);
        expect(current.marker).toBe("Preserved");
        expect(statSync(config).mode & 0o777).toBe(0o600);
        const provider = localVoice(current.voice);
        expect(
          (
            await provider.transcribe(
              readFileSync(
                "work/ultracode/five-phase/voice/audio/qualify.webm",
              ),
              new AbortController().signal,
            )
          ).toLowerCase(),
        ).toContain("country");
      }
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  },
  60000,
);
