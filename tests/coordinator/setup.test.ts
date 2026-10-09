import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCoordinator } from "../../packages/coordinator/src/server";
it("boots the setup-generated hash-only config with owner-only permissions", async () => {
  const state = mkdtempSync(join(tmpdir(), "simurgh-bootstrap-"));
  const build = spawnSync(
    resolve("node_modules/.bin/esbuild"),
    [
      "packages/coordinator/src/setup.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${join(state, "setup.mjs")}`,
    ],
    { encoding: "utf8" },
  );
  expect(build.status, build.stderr).toBe(0);
  const setup = spawnSync(process.execPath, [join(state, "setup.mjs"), state], {
    encoding: "utf8",
  });
  expect(setup.status, setup.stderr).toBe(0);
  const configPath = join(state, "coordinator.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
  expect(config.users.every((u: any) => u.tokenHash && !u.token)).toBe(true);
  const token = setup.stdout.match(/Alice: ([A-Za-z0-9_-]+)/)![1];
  const app = createCoordinator(config);
  await app.listen(0);
  try {
    expect(
      (
        await fetch(app.url + "/api/session", {
          method: "POST",
          headers: {
            Origin: config.origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token }),
        })
      ).status,
    ).toBe(200);
  } finally {
    await app.close();
    rmSync(state, { recursive: true, force: true });
  }
});
