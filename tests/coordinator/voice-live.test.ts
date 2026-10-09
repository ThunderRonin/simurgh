import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { localVoice } from "../../packages/coordinator/src/voice";
it.skipIf(process.env.SIMURGH_VOICE_VERIFY !== "1")(
  "transcribes actual WebM locally and produces nonblank PCM speech under network-none containers",
  async () => {
    const image = spawnSync(
      "docker",
      ["image", "inspect", "simurgh-voice:local", "--format", "{{.Id}}"],
      { encoding: "utf8" },
    ).stdout.trim();
    const provider = localVoice({
      image,
      modelDirectory: resolve("work/ultracode/five-phase/voice/models"),
    });
    const text = await provider.transcribe(
      readFileSync("work/ultracode/five-phase/voice/audio/qualify.webm"),
      new AbortController().signal,
    );
    expect(text.toLowerCase()).toContain("country");
    const wave = await provider.speech(
      "This is a local investigation finding with bounded audio.",
      new AbortController().signal,
    );
    expect(wave.length).toBeGreaterThan(10000);
    expect(wave.subarray(44).some((byte) => byte !== 0)).toBe(true);
    const active = spawnSync(
      "docker",
      ["ps", "--filter", "name=simurgh-voice-", "--format", "{{.Names}}"],
      { encoding: "utf8" },
    );
    expect(active.stdout.trim()).toBe("");
    const abort = new AbortController();
    const pending = provider.transcribe(
      readFileSync("work/ultracode/five-phase/voice/audio/qualify.webm"),
      abort.signal,
    );
    setTimeout(() => abort.abort(), 100);
    await expect(pending).rejects.toThrow();
    expect(
      spawnSync(
        "docker",
        ["ps", "--filter", "name=simurgh-voice-", "--format", "{{.Names}}"],
        { encoding: "utf8" },
      ).stdout.trim(),
    ).toBe("");
    const stream = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--entrypoint",
        "ffmpeg",
        "--mount",
        `type=bind,src=${resolve("work/ultracode/five-phase/voice/audio")},dst=/audio,readonly`,
        image,
        "-v",
        "error",
        "-i",
        "/audio/jfk.wav",
        "-c:a",
        "libopus",
        "-f",
        "webm",
        "pipe:1",
      ],
      { maxBuffer: 3 * 1024 * 1024 },
    );
    expect(stream.status).toBe(0);
    expect(
      (
        await provider.transcribe(stream.stdout, new AbortController().signal)
      ).toLowerCase(),
    ).toContain("country");
    await expect(
      provider.transcribe(
        Buffer.from("invalid audio"),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(
      spawnSync(
        "docker",
        ["ps", "--filter", "name=simurgh-voice-", "--format", "{{.Names}}"],
        { encoding: "utf8" },
      ).stdout.trim(),
    ).toBe("");
  },
  30000,
);
