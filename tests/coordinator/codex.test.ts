import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexAdapter } from "../../packages/coordinator/src/codex";
const executable = resolve("tests/coordinator/host-fixture.mjs");
chmodSync(executable, 0o700);
async function exercise(mode: string, cancel = false) {
  const root = mkdtempSync(join(tmpdir(), "simurgh-protocol-"));
  const cwd = join(root, mode);
  mkdirSync(cwd);
  const controller = new AbortController();
  const read = vi.fn(async () => ({
    id: "evidence",
    kind: "source" as const,
    title: "Selection",
    origin: "user-supplied" as const,
    capturedAt: new Date().toISOString(),
    scope: "Selection",
    data: "synthetic",
    limitations: [],
  }));
  const adapter = codexAdapter({
    executable,
    home: root,
    cwd,
    model: "approved",
    provider: "openai",
    isolationQualified: true,
  });
  const timer = cancel ? setTimeout(() => controller.abort(), 100) : undefined;
  try {
    return {
      result: await adapter.run(
        { question: "Test", references: [], signal: controller.signal, read },
        () => {},
      ),
      calls: read.mock.calls.length,
    };
  } finally {
    if (timer) clearTimeout(timer);
    rmSync(root, { recursive: true, force: true });
  }
}
describe("real child protocol adapter with synthetic host only", () => {
  it("routes only validated non-replayed reference requests coalesced with the turn response", async () => {
    expect((await exercise("badcalls")).calls).toBe(1);
  });
  it.each([
    "version",
    "mcp",
    "auth",
    "native",
    "approval",
    "output",
    "exit",
    "null",
    "primitive",
    "instructions",
  ])("fails closed for %s", async (mode) => {
    await expect(exercise(mode)).rejects.toThrow();
  });
  it("fails promptly when the executable is missing", async () => {
    const start = Date.now();
    const adapter = codexAdapter({
      executable: "/does-not-exist/simurgh",
      home: "/tmp",
      cwd: "/tmp",
      model: "approved",
      provider: "openai",
      isolationQualified: true,
    });
    await expect(
      adapter.run(
        {
          question: "Test",
          references: [],
          signal: new AbortController().signal,
          read: async () => {
            throw new Error("Denied");
          },
        },
        () => {},
      ),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });
  it.each(["hang-init", "hang-turn", "hang"])(
    "aborts and kills owned child during %s",
    async (mode) => {
      const start = Date.now();
      await expect(exercise(mode, true)).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(2000);
    },
  );
  it("refuses unqualified production settings", () => {
    expect(() =>
      codexAdapter({
        executable,
        home: "/tmp",
        cwd: "/tmp",
        model: "x",
        provider: "openai",
        isolationQualified: false,
      }),
    ).toThrow("Qualified");
  });
});
