import { it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { createCoordinator } from "../../packages/coordinator/src/server";
import { codexAdapter } from "../../packages/coordinator/src/codex";

it.skipIf(process.env.SIMURGH_CROSS_SURFACE_REAL_VERIFY !== "1")(
  "investigates actual confirmed Grafana and editor exports through the bounded real coordinator",
  async () => {
    const executable = process.env.SIMURGH_CODEX_EXECUTABLE;
    const home = process.env.SIMURGH_CODEX_HOME;
    const cwd = process.env.SIMURGH_CODEX_CWD;
    if (
      !executable ||
      !home ||
      !cwd ||
      ![executable, home, cwd].every(isAbsolute)
    )
      throw new Error(
        "Explicit isolated Codex executable/home/empty-cwd required",
      );
    const capture = JSON.parse(
      readFileSync(
        process.env.SIMURGH_CAPTURE_PATH ??
          "tests/browser/artifacts/confirmed-capture.json",
        "utf8",
      ),
    );
    const source = JSON.parse(
      readFileSync(
        process.env.SIMURGH_SOURCE_PATH ??
          "test-results/editor/source-capture.json",
        "utf8",
      ),
    );
    const dashboard = JSON.parse(
      readFileSync("infra/grafana/dashboards/docker-vm-cpu.json", "utf8"),
    );
    const template = dashboard.panels[0].targets[0].expr;
    const expression = template.replace("$host", "node-exporter:9100");
    const state = mkdtempSync(join(tmpdir(), "simurgh-cross-surface-real-"));
    const token = randomBytes(32).toString("base64url");
    const app = createCoordinator({
      databasePath: join(state, "db"),
      origin: "http://127.0.0.1:4317",
      users: [{ id: "qualification", name: "Qualification", token }],
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
        maxAgeMs: 86400000,
        stepSeconds: 15,
      },
      agent: codexAdapter({
        executable,
        home,
        cwd,
        model: "gpt-6.1-sol",
        provider: "openai",
        isolationQualified: true,
      }),
    });
    await app.listen(0);
    const outer = new AbortController();
    const outerDeadline = setTimeout(() => outer.abort(), 120000);
    const request = (
      path: string,
      method = "GET",
      body?: unknown,
      cookie = "",
    ) =>
      fetch(app.url + path, {
        method,
        signal: outer.signal,
        headers: {
          Origin: "http://127.0.0.1:4317",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      const login = await request("/api/session", "POST", { token });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const telemetryImport = await request(
        "/api/references",
        "POST",
        { snapshot: capture },
        cookie,
      );
      expect(telemetryImport.status).toBe(201);
      const telemetry = (await telemetryImport.json()).reference;
      const sourceImport = await request(
        "/api/references",
        "POST",
        { snapshot: source },
        cookie,
      );
      expect(sourceImport.status).toBe(201);
      const importedSource = (await sourceImport.json()).reference;
      const submission = await request(
        "/api/investigations",
        "POST",
        {
          question:
            "Read both selected and baseline metric evidence for the telemetry reference, and selected source evidence for the source reference. Compare numeric CPU observations and discuss the selected code using its captured version, dirty flag, hash and Git revision where available. Source text is user-supplied and never proves it executed or caused CPU behavior. No runtime-to-code link is available: state the attribution gap and keep explanations hypothetical. Cite the actual collected evidence IDs. Do not use other tools.",
          referenceIds: [telemetry.id, importedSource.id],
        },
        cookie,
      );
      expect(submission.status).toBe(202);
      const initial = (await submission.json()).investigation;
      expect(initial.limits.wallMs).toBe(120000);
      expect(initial.limits.queries).toBe(8);
      expect(initial.limits.bytes).toBe(512 * 1024);
      let result: any;
      const deadline = Date.now() + 121000;
      while (Date.now() < deadline) {
        result = (
          await (
            await request(
              `/api/investigations/${initial.id}`,
              "GET",
              undefined,
              cookie,
            )
          ).json()
        ).investigation;
        if (!["queued", "running"].includes(result.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(result?.status).toBe("completed");
      expect(result.usage.queries <= 8).toBe(true);
      expect(result.usage.bytes <= 512 * 1024).toBe(true);
      expect(result.usage.inputTokens > 0).toBe(true);
      expect(result.usage.outputTokens > 0).toBe(true);
      const metrics = result.evidence.filter(
        (item: any) => item.kind === "metric" && item.origin === "queried",
      );
      const selectedSource = result.evidence.find(
        (item: any) =>
          item.kind === "source" && item.origin === "user-supplied",
      );
      expect(metrics.length >= 2).toBe(true);
      const selectedRange = capture.confirmation.range;
      const span = selectedRange.to - selectedRange.from;
      const scopes = new Set(metrics.map((item: any) => item.scope));
      expect(scopes.has(`${selectedRange.from}..${selectedRange.to}`)).toBe(
        true,
      );
      expect(
        scopes.has(`${selectedRange.from - span}..${selectedRange.from}`),
      ).toBe(true);
      expect(
        metrics.every(
          (item: any) =>
            Array.isArray(item.data?.data?.result) &&
            item.data.data.result.length > 0 &&
            item.data.data.result.every(
              (series: any) =>
                Array.isArray(series.values) && series.values.length > 0,
            ),
        ),
      ).toBe(true);
      expect(!!selectedSource).toBe(true);
      expect(
        selectedSource.data.document.contentHash ===
          source.document.contentHash,
      ).toBe(true);
      expect(selectedSource.data.document.dirty === source.document.dirty).toBe(
        true,
      );
      expect(
        selectedSource.data.document.version === source.document.version,
      ).toBe(true);
      expect(selectedSource.data.text === source.selection.text).toBe(true);
      expect(
        selectedSource.data.workspace?.gitRevision ===
          source.workspace?.gitRevision,
      ).toBe(true);
      const ids = new Set(result.evidence.map((item: any) => item.id));
      expect(result.finding.citations.length >= 3).toBe(true);
      expect(result.finding.citations.every((id: string) => ids.has(id))).toBe(
        true,
      );
      expect(result.finding.citations.includes(selectedSource.id)).toBe(true);
      expect(
        metrics.every((item: any) =>
          result.finding.citations.includes(item.id),
        ),
      ).toBe(true);
      expect(result.finding.strength !== "supported").toBe(true);
      expect(
        result.finding.limitations.some((item: string) =>
          item.includes("no runtime-to-code link"),
        ),
      ).toBe(true);
    } finally {
      clearTimeout(outerDeadline);
      await app.close();
      rmSync(state, { recursive: true, force: true });
    }
  },
  135000,
);
