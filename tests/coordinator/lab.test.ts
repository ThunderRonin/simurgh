import { it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCoordinator } from "../../packages/coordinator/src/server";
it.skipIf(process.env.SIMURGH_LAB_VERIFY !== "1")(
  "imports the exact browser download and collects scoped fresh local Grafana metrics",
  async () => {
    const capture = JSON.parse(
      readFileSync("tests/browser/artifacts/confirmed-capture.json", "utf8"),
    );
    const definition = JSON.parse(
      readFileSync("infra/grafana/dashboards/docker-vm-cpu.json", "utf8"),
    );
    const template = definition.panels[0].targets[0].expr;
    const expression = template.replace("$host", "node-exporter:9100");
    const dir = mkdtempSync(join(tmpdir(), "simurgh-live-lab-"));
    const app = createCoordinator({
      databasePath: join(dir, "db"),
      origin: "http://127.0.0.1:4317",
      users: [{ id: "alice", name: "Alice", token: "a".repeat(64) }],
      telemetry: {
        origin: "http://127.0.0.1:3300",
        orgId: 1,
        dashboardUid: "simurgh-cpu-lab",
        panelId: 1,
        datasourceUid: "prometheus-local",
        template,
        expression,
        variables: { host: "node-exporter:9100" },
        labels: { cpu: Array.from({ length: 256 }, (_, n) => String(n)) },
        maxSpanMs: 15 * 60000,
        maxAgeMs: 7 * 86400000,
        stepSeconds: 15,
      },
      agent: {
        run: async (input) => {
          const selected = await input.read(input.references[0].id, "selected");
          const baseline = await input.read(input.references[0].id, "baseline");
          return {
            strength: "hypothesis",
            summary: "Local metric checks completed; no real model inference.",
            citations: [selected.id, baseline.id],
            limitations: ["Test-only deterministic adapter."],
            nextCheck: "Qualify real agent isolation",
          };
        },
      },
    });
    await app.listen(0);
    const request = (
      path: string,
      method = "GET",
      body?: unknown,
      cookie = "",
    ) =>
      fetch(app.url + path, {
        method,
        headers: {
          Origin: "http://127.0.0.1:4317",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      const cookie = (
        await request("/api/session", "POST", { token: "a".repeat(64) })
      ).headers
        .get("set-cookie")!
        .split(";")[0];
      const imported = await request(
        "/api/references",
        "POST",
        { snapshot: capture },
        cookie,
      );
      expect(imported.status, await imported.clone().text()).toBe(201);
      const ref = (await imported.json()).reference;
      const forged = structuredClone(capture);
      forged.selected.labels = {};
      forged.series[0].labels = {};
      expect(
        (await request("/api/references", "POST", { snapshot: forged }, cookie))
          .status,
      ).toBe(422);
      const inv = (
        await (
          await request(
            "/api/investigations",
            "POST",
            { question: "Check local CPU only", referenceIds: [ref.id] },
            cookie,
          )
        ).json()
      ).investigation;
      let result: any;
      for (let n = 0; n < 100; n++) {
        result = (
          await (
            await request(
              `/api/investigations/${inv.id}`,
              "GET",
              undefined,
              cookie,
            )
          ).json()
        ).investigation;
        if (!["queued", "running"].includes(result.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(result.status, result.stopReason ?? "").toBe("completed");
      expect(result.evidence).toHaveLength(2);
      expect(result.evidence.every((e: any) => e.origin === "queried")).toBe(
        true,
      );
      for (const e of result.evidence) {
        expect(e.data.data.result.length).toBeGreaterThan(0);
        expect(e.data.data.result.every((s: any) => s.metric.cpu === "0")).toBe(
          true,
        );
      }
      expect(result.usage.queries).toBe(2);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
