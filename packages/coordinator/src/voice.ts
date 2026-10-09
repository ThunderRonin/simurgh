import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
export interface VoiceProvider {
  transcribe(audio: Buffer, signal: AbortSignal): Promise<string>;
  speech(text: string, signal: AbortSignal): Promise<Buffer>;
}
export interface VoiceSettings {
  image: string;
  modelDirectory: string;
  dockerExecutable?: string;
}
export const VOICE_MODEL_HASH =
  "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f";
export function localVoice(settings: VoiceSettings): VoiceProvider {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(settings.image) ||
    !isAbsolute(settings.modelDirectory)
  )
    throw new Error(
      "Voice requires a fixed local image ID and absolute model directory",
    );
  const modelDirectory = realpathSync(settings.modelDirectory);
  const model = readFileSync(join(modelDirectory, "ggml-tiny.en.bin"));
  if (
    model.length !== 77704715 ||
    createHash("sha256").update(model).digest("hex") !== VOICE_MODEL_HASH
  )
    throw new Error("Voice model missing or hash mismatch");
  const docker = settings.dockerExecutable ?? "docker";
  let busy = false;
  const image = spawnSync(
    docker,
    ["image", "inspect", settings.image, "--format", "{{.Id}}"],
    { encoding: "utf8", timeout: 5000 },
  );
  if (image.status !== 0 || image.stdout.trim() !== settings.image)
    throw new Error("Local voice image unavailable; run voice setup");
  async function operation(
    mode: "transcribe" | "speech",
    input: Buffer,
    signal: AbortSignal,
    max: number,
  ) {
    if (busy) throw new Error("Voice busy");
    if (signal.aborted) throw new Error("Voice cancelled");
    busy = true;
    const name = `simurgh-voice-${randomUUID()}`;
    const uid = process.getuid?.() || 65534;
    const gid = process.getgid?.() || 65534;
    const child = spawn(
      docker,
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--user",
        `${uid}:${gid}`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "512m",
        "--cpus",
        "2",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--mount",
        `type=bind,src=${modelDirectory},dst=/models,readonly`,
        "-i",
        settings.image,
        mode,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let failed = false;
    const remove = () =>
      new Promise<void>((resolve) => {
        const cleanup = spawn(docker, ["rm", "-f", name], { stdio: "ignore" });
        const timer = setTimeout(() => {
          cleanup.kill("SIGKILL");
          resolve();
        }, 2000);
        cleanup.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
        cleanup.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    const abort = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(abort, 15000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    try {
      const collected = collectVoiceProcessOutput(
        child,
        max,
        () => failed || signal.aborted,
        abort,
      );
      child.stdin.end(input);
      const output = await collected;
      return output;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      await remove();
      busy = false;
    }
  }
  return {
    async transcribe(audio, signal) {
      if (audio.length > 2 * 1024 * 1024) throw new Error("Audio too large");
      const output = await operation("transcribe", audio, signal, 32000);
      const parsed = JSON.parse(output.toString("utf8"));
      if (
        !parsed ||
        typeof parsed.text !== "string" ||
        !parsed.text.trim() ||
        parsed.text.length > 4000
      )
        throw new Error("No transcript");
      return parsed.text;
    },
    async speech(text, signal) {
      if (!text || text.length > 1000) throw new Error("Speech text invalid");
      const wave = await operation(
        "speech",
        Buffer.from(text),
        signal,
        4 * 1024 * 1024,
      );
      if (
        wave.length < 44 ||
        wave.toString("ascii", 0, 4) !== "RIFF" ||
        wave.toString("ascii", 8, 12) !== "WAVE"
      )
        throw new Error("Invalid speech output");
      return wave;
    },
  };
}

/** Internal transport collector: process exit can precede the final stdio bytes. */
export function collectVoiceProcessOutput(
  child: ChildProcessWithoutNullStreams,
  max: number,
  failed: () => boolean,
  abort: () => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    child.on("error", () => reject(new Error("Local voice unavailable")));
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > max) {
        abort();
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0 || failed())
        reject(new Error("Local voice failed or cancelled"));
      else resolve(Buffer.concat(chunks));
    });
  });
}
