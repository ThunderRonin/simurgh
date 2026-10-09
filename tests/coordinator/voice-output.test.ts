import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { collectVoiceProcessOutput } from "../../packages/coordinator/src/voice";
it("waits for complete child stdout after exit before returning transcript bytes", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process');process.stdout.write('{"text":');spawn(process.execPath,['-e','setTimeout(()=>process.stdout.write(JSON.stringify("Complete transcript")+"}"),100)'],{stdio:['ignore',1,2]});process.exit(0);`,
    ],
    { stdio: "pipe" },
  );
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const result = await collectVoiceProcessOutput(
    child,
    32000,
    () => false,
    () => child.kill("SIGKILL"),
  );
  expect(exited).toBe(true);
  expect(JSON.parse(result.toString("utf8")).text).toBe("Complete transcript");
});
