import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  renameSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
const configPath = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/setup-voice.mjs /private/coordinator.json",
  );
const stat = statSync(configPath);
if ((stat.mode & 0o077) !== 0)
  throw new Error("Coordinator config must be private");
const original = readFileSync(configPath, "utf8");
const config = JSON.parse(original);
const models = join(dirname(configPath), "voice-models");
mkdirSync(models, { recursive: true, mode: 0o700 });
const modelPath = join(models, "ggml-tiny.en.bin");
const expected =
  "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f";
let model;
try {
  model = readFileSync(modelPath);
} catch {
  const response = await fetch(
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin",
  );
  if (!response.ok) throw new Error("Model download failed");
  if (!response.body) throw new Error("Model download has no body");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 77704715)
        throw new Error("Model download exceeds expected size");
      chunks.push(part.value);
    }
    model = Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}
if (
  model.length !== 77704715 ||
  createHash("sha256").update(model).digest("hex") !== expected
)
  throw new Error("Model hash/size mismatch; existing file preserved");
try {
  writeFileSync(modelPath, model, { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
const imageTag = "simurgh-voice:local";
const build = spawnSync(
  "docker",
  ["build", "--tag", imageTag, resolve("infra/voice")],
  { stdio: "inherit" },
);
if (build.status !== 0) throw new Error("Local voice image build failed");
const image = spawnSync(
  "docker",
  ["image", "inspect", imageTag, "--format", "{{.Id}}"],
  { encoding: "utf8" },
);
if (image.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image.stdout.trim()))
  throw new Error("Local image unavailable");
config.voice = { image: image.stdout.trim(), modelDirectory: models };
if (readFileSync(configPath, "utf8") !== original)
  throw new Error(
    "Coordinator configuration changed during setup; preserved. Retry setup.",
  );
const temporary = configPath + ".voice-setup.tmp";
writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
renameSync(temporary, configPath);
console.log(
  "Local voice configured; restart the coordinator. Tokens and existing settings preserved.",
);
