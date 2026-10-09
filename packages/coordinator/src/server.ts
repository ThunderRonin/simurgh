import {
  createServer,
  type ServerResponse,
  type IncomingMessage,
} from "node:http";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import Database from "better-sqlite3";
import { readFileSync, realpathSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  previewImportedSnapshot,
  createInvestigationSubmission,
  presentFinding,
  type InvestigationRecord,
  type WorkspaceReference,
  type WorkspaceLimits,
  type Evidence,
  type Finding,
} from "../../shared/src/investigation";
import type { ConfirmedCapture } from "../../shared/src/index";
import {
  validateSourceSnapshot,
  type SourceSnapshot,
} from "../../shared/src/source";
import type { VoiceProvider } from "./voice";

export interface AgentAdapter {
  run(
    input: {
      question: string;
      references: WorkspaceReference[];
      signal: AbortSignal;
      read: (
        referenceId: string,
        window: "selected" | "baseline",
      ) => Promise<Evidence>;
    },
    onUsage: (input: number, output: number) => void,
  ): Promise<Finding>;
}
export interface TelemetryPolicy {
  origin: string;
  orgId: number;
  dashboardUid: string;
  panelId: number;
  datasourceUid: string;
  expression: string;
  template?: string;
  variables?: Record<string, string>;
  stepSeconds?: number;
  labels: Record<string, string[]>;
  maxSpanMs: number;
  maxAgeMs: number;
  token?: string;
}
export interface CoordinatorOptions {
  databasePath: string;
  origin: string;
  users: { id: string; name: string; token?: string; tokenHash?: string }[];
  limits?: WorkspaceLimits;
  telemetry?: TelemetryPolicy;
  agent?: AgentAdapter;
  sessionMs?: number;
  workspaceDist?: string;
  voice?: VoiceProvider;
}
class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const defaults: WorkspaceLimits = {
  wallMs: 120000,
  queries: 8,
  bytes: 512 * 1024,
  concurrency: 1,
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const iso = () => new Date().toISOString();

export function createCoordinator(options: CoordinatorOptions) {
  if (new URL(options.origin).hostname !== "127.0.0.1")
    throw new Error("Loopback origin required");
  if (
    options.users.some(
      (u) =>
        !/^[A-Za-z0-9_-]{1,64}$/.test(u.id) ||
        !(
          (u.token && u.token.length >= 43) ||
          (u.tokenHash && /^[a-f0-9]{64}$/.test(u.tokenHash))
        ),
    ) ||
    new Set(options.users.map((u) => u.id)).size !== options.users.length ||
    new Set(options.users.map((u) => u.tokenHash ?? hash(u.token!))).size !==
      options.users.length
  )
    throw new Error(
      "Distinct principals and high entropy bootstrap tokens required",
    );
  mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  const stateDir = statSync(dirname(options.databasePath));
  if (
    (stateDir.mode & 0o077) !== 0 ||
    (process.getuid && stateDir.uid !== process.getuid())
  )
    throw new Error("State directory must be owner-only");
  const db = new Database(options.databasePath);
  const staticFiles = new Map<string, { bytes: Buffer; type: string }>();
  if (options.workspaceDist) {
    const root = realpathSync(options.workspaceDist);
    for (const [name, type] of [
      ["index.html", "text/html; charset=utf-8"],
      ["workspace.js", "text/javascript; charset=utf-8"],
      ["workspace.css", "text/css; charset=utf-8"],
    ] as const) {
      const path = realpathSync(join(root, name));
      if (dirname(path) !== root)
        throw new Error("Workspace build asset escaped configured directory");
      const bytes = readFileSync(path);
      if (bytes.length > 5 * 1024 * 1024)
        throw new Error("Workspace asset too large");
      staticFiles.set(name === "index.html" ? "/" : `/${name}`, {
        bytes,
        type,
      });
    }
  }
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS refs(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),created INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS investigations(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),created INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS grants(item TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(item,user_id));",
  );
  for (const old of db.prepare("SELECT id,token_hash FROM users").all() as {
    id: string;
    token_hash: string;
  }[]) {
    const user = options.users.find((u) => u.id === old.id);
    if (!user || old.token_hash !== (user.tokenHash ?? hash(user.token!)))
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(old.id);
  }
  for (const u of options.users)
    db.prepare(
      "INSERT INTO users VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,token_hash=excluded.token_hash",
    ).run(u.id, u.name, u.tokenHash ?? hash(u.token!));
  const limits = options.limits ?? defaults;
  if (
    ["wallMs", "queries", "bytes", "concurrency"].some(
      (key) =>
        !Number.isSafeInteger(limits[key as keyof WorkspaceLimits]) ||
        limits[key as keyof WorkspaceLimits] < 1,
    ) ||
    limits.wallMs > 120000 ||
    limits.queries > 8 ||
    limits.bytes > 512 * 1024 ||
    limits.concurrency > 4
  ) {
    db.close();
    throw new Error("Invalid bounded limits");
  }
  const runs = new Map<string, AbortController>();
  const voiceRuns = new Set<{
    user: string;
    id?: string;
    sessionHash: string;
    controller: AbortController;
  }>();
  let voiceBusy = false;
  const streams = new Set<{
    id: string;
    user: string;
    expires: number;
    res: ServerResponse;
  }>();
  const save = (i: InvestigationRecord) =>
    db
      .prepare("UPDATE investigations SET payload=? WHERE id=?")
      .run(JSON.stringify(i), i.id);
  const get = (id: string): InvestigationRecord | null => {
    const row = db
      .prepare("SELECT payload FROM investigations WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  };
  const can = (i: InvestigationRecord, user: string) =>
    i.ownerId === user ||
    !!db
      .prepare("SELECT 1 FROM grants WHERE item=? AND user_id=?")
      .get(i.id, user);
  const requireItem = (id: string, user: string, owner = false) => {
    const i = get(id);
    if (!i || !(owner ? i.ownerId === user : can(i, user)))
      throw new HttpError(404, "not_found", "Resource unavailable");
    i.grants = (
      db.prepare("SELECT user_id FROM grants WHERE item=?").all(id) as {
        user_id: string;
      }[]
    ).map((g) => g.user_id);
    return i;
  };
  const emit = (i: InvestigationRecord) => {
    for (const s of streams) {
      if (s.id !== i.id) continue;
      if (s.expires <= Date.now() || !can(i, s.user)) {
        s.res.end();
        streams.delete(s);
      } else if (s.res.writableLength > 1024 * 1024) {
        s.res.end();
        streams.delete(s);
      } else
        s.res.write(
          `event: investigation\ndata: ${JSON.stringify({ investigation: requireItem(i.id, s.user) })}\n\n`,
        );
    }
  };
  const stop = (
    i: InvestigationRecord,
    status: "cancelled" | "limited" | "failed",
    reason: string,
  ) => {
    if (!["queued", "running"].includes(i.status)) return;
    i.status = status;
    i.stopReason = reason;
    runs.get(i.id)?.abort();
    i.usage.elapsedMs = Date.now() - Date.parse(i.createdAt);
    save(i);
    emit(i);
  };
  for (const row of db.prepare("SELECT payload FROM investigations").all() as {
    payload: string;
  }[]) {
    const i: InvestigationRecord = JSON.parse(row.payload);
    if (["running", "queued"].includes(i.status)) {
      i.status = "failed";
      i.stopReason = "Coordinator restarted; prior agent work was not resumed.";
      save(i);
    }
  }
  const retention = () => {
    const cutoff = Date.now() - 7 * 86400000;
    for (const row of db
      .prepare("SELECT id FROM investigations WHERE created<?")
      .all(cutoff) as { id: string }[]) {
      runs.get(row.id)?.abort();
      for (const s of streams)
        if (s.id === row.id) {
          s.res.end();
          streams.delete(s);
        }
      db.prepare("DELETE FROM investigations WHERE id=?").run(row.id);
    }
    db.prepare("DELETE FROM refs WHERE created<?").run(cutoff);
    db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    for (const s of streams)
      if (s.expires <= Date.now()) {
        s.res.end();
        streams.delete(s);
      }
    for (const operation of voiceRuns) {
      const session = db
        .prepare("SELECT 1 FROM sessions WHERE hash=? AND expires>?")
        .get(operation.sessionHash, Date.now());
      const item = operation.id ? get(operation.id) : null;
      if (!session || (operation.id && (!item || !can(item, operation.user))))
        operation.controller.abort();
    }
  };
  retention();
  const cleanup = setInterval(retention, 1000);
  cleanup.unref();
  async function validateTelemetry(c: ConfirmedCapture) {
    const p = options.telemetry;
    if (!p)
      throw new HttpError(422, "scope", "Telemetry policy is not configured");
    if (
      c.panel.grafanaOrigin !== p.origin ||
      c.panel.grafanaOrgId !== p.orgId ||
      c.panel.dashboardUid !== p.dashboardUid ||
      c.panel.panelId !== p.panelId ||
      c.panel.datasourceUid !== p.datasourceUid ||
      c.panel.datasourceType !== "prometheus" ||
      c.transformations.length ||
      (c.variables.length > 0 &&
        c.variables.length !== Object.keys(p.variables ?? {}).length) ||
      c.variables.some(
        (v) => v.values.length !== 1 || v.values[0] !== p.variables?.[v.name],
      ) ||
      c.query.length !== 1 ||
      ![p.expression, p.template ?? p.expression].includes(
        c.query[0].expression ?? "",
      ) ||
      (c.query[0].executedQueryString !== undefined &&
        ![
          p.expression,
          `Expr: ${p.expression}\nStep: ${p.stepSeconds ?? 15}s`,
        ].includes(c.query[0].executedQueryString)) ||
      c.query[0].datasourceUid !== p.datasourceUid ||
      c.range.to - c.range.from > p.maxSpanMs ||
      c.range.to > Date.now() + 60000 ||
      Date.now() - c.range.from > p.maxAgeMs ||
      Object.keys(c.selected.labels).length === 0 ||
      Object.keys(c.selected.labels).sort().join(",") !==
        Object.keys(p.labels).sort().join(",") ||
      Object.entries(c.selected.labels).some(
        ([k, v]) => !p.labels[k]?.includes(v),
      )
    )
      throw new HttpError(
        422,
        "scope",
        "Telemetry reference is outside configured policy",
      );
  }
  async function run(i: InvestigationRecord) {
    if (!options.agent) return;
    const controller = new AbortController();
    runs.set(i.id, controller);
    i.status = "running";
    save(i);
    emit(i);
    const timer = setTimeout(
      () => stop(i, "limited", "Wall clock budget reached"),
      limits.wallMs,
    );
    const started = Date.now();
    let active = 0;
    const read = async (
      referenceId: string,
      window: "selected" | "baseline",
    ): Promise<Evidence> => {
      if (controller.signal.aborted || get(i.id)?.status !== "running")
        throw new Error("Run stopped");
      if (
        active >= limits.concurrency ||
        i.usage.queries >= limits.queries ||
        i.usage.bytes >= limits.bytes
      ) {
        stop(i, "limited", "Evidence budget reached");
        throw new Error("Evidence budget reached");
      }
      i.usage.queries++;
      active++;
      save(i);
      try {
        if (!["selected", "baseline"].includes(window))
          throw new Error("Unsupported window");
        const ref = i.references.find((r) => r.id === referenceId);
        if (!ref) throw new Error("Unknown reference");
        const charge = (bytes: number) => {
          if (controller.signal.aborted) throw new Error("Run stopped");
          if (bytes > limits.bytes - i.usage.bytes) {
            stop(i, "limited", "Data budget reached");
            throw new Error("Data budget reached");
          }
          i.usage.bytes += bytes;
          save(i);
        };
        let evidence: Evidence;
        if (ref.kind === "source") {
          const s = ref.snapshot as SourceSnapshot;
          evidence = {
            id: randomUUID(),
            kind: "source",
            title: ref.title,
            origin: "user-supplied",
            capturedAt: iso(),
            scope: "Explicitly imported selection only",
            data: {
              text: s.selection.text,
              documentVersion: s.document.version,
              document: s.document,
              workspace: s.workspace,
              selection: s.selection,
              symbols: s.symbols ?? [],
              definitions: s.definitions ?? [],
            },
            limitations: [
              ...s.limitations,
              "Definition locations are navigation hints; target contents and versions were not read.",
              "User-supplied source; no filesystem read or runtime attribution.",
            ],
          };
        } else {
          const c = ref.snapshot as ConfirmedCapture;
          await validateTelemetry(c);
          const p = options.telemetry!;
          const headers: Record<string, string> = {
            "X-Grafana-Org-Id": String(p.orgId),
          };
          if (p.token) headers.Authorization = `Bearer ${p.token}`;
          const dashboard = await boundedJson(
            await fetch(
              `${p.origin}/api/dashboards/uid/${encodeURIComponent(p.dashboardUid)}`,
              { headers, signal: controller.signal, redirect: "error" },
            ),
            Math.min(64 * 1024, limits.bytes - i.usage.bytes),
            charge,
          );
          if (
            !record(dashboard) ||
            !record(dashboard.dashboard) ||
            !Array.isArray(dashboard.dashboard.panels)
          )
            throw new Error("Invalid authoritative dashboard");
          const panel = dashboard.dashboard.panels.find(
            (v: unknown) => record(v) && v.id === p.panelId,
          );
          if (
            !record(panel) ||
            panel.repeat ||
            !Array.isArray(panel.targets) ||
            panel.targets.length !== 1 ||
            !record(panel.targets[0]) ||
            panel.targets[0].expr !== (p.template ?? p.expression) ||
            panel.type !== "timeseries" ||
            panel.timeShift ||
            panel.timeFrom ||
            panel.repeatDirection ||
            (record(panel.fieldConfig) &&
              Array.isArray(panel.fieldConfig.overrides) &&
              panel.fieldConfig.overrides.length > 0) ||
            panel.targets[0].hide === true ||
            panel.targets[0].instant === true ||
            panel.targets[0].range !== true ||
            panel.targets[0].refId !== c.query[0].refId ||
            (panel.targets[0].queryType !== undefined &&
              panel.targets[0].queryType !== "range") ||
            panel.targets[0].interval !== undefined ||
            panel.targets[0].intervalMs !== undefined ||
            !record(panel.targets[0].datasource) ||
            panel.targets[0].datasource.uid !== p.datasourceUid ||
            (Array.isArray(panel.transformations) &&
              panel.transformations.length)
          )
            throw new Error("Authoritative dashboard changed");
          const span = c.confirmation.range.to - c.confirmation.range.from;
          const to =
            window === "selected"
              ? c.confirmation.range.to
              : c.confirmation.range.from;
          const from = to - span;
          if (Date.now() - from > p.maxAgeMs)
            throw new Error("Baseline outside policy");
          const metricUrl = new URL(
            `${p.origin}/api/datasources/proxy/uid/${encodeURIComponent(p.datasourceUid)}/api/v1/query_range`,
          );
          metricUrl.search = new URLSearchParams({
            query: p.expression,
            start: String(from / 1000),
            end: String(to / 1000),
            step: String(
              Math.max(p.stepSeconds ?? 15, Math.ceil(span / 1000000)),
            ),
          }).toString();
          const data = await boundedJson(
            await fetch(metricUrl, {
              headers,
              signal: controller.signal,
              redirect: "error",
            }),
            Math.max(0, limits.bytes - i.usage.bytes),
            charge,
          );
          if (
            !record(data) ||
            data.status !== "success" ||
            !record(data.data) ||
            data.data.resultType !== "matrix" ||
            !Array.isArray(data.data.result)
          )
            throw new Error("Invalid metric response");
          const series = data.data.result.filter(
            (series: unknown) =>
              record(series) &&
              record(series.metric) &&
              Object.entries(c.selected.labels).every(
                ([key, value]) =>
                  series.metric &&
                  record(series.metric) &&
                  series.metric[key] === value,
              ),
          );
          if (
            series.some(
              (series: unknown) =>
                !record(series) ||
                !record(series.metric) ||
                Object.entries(series.metric).some(
                  ([key, value]) =>
                    key !== "__name__" &&
                    (typeof value !== "string" ||
                      !p.labels[key]?.includes(value)),
                ) ||
                !Array.isArray(series.values) ||
                series.values.length > 1001 ||
                series.values.some(
                  (v: unknown) =>
                    !Array.isArray(v) ||
                    v.length !== 2 ||
                    typeof v[0] !== "number" ||
                    v[0] * 1000 < from ||
                    v[0] * 1000 > to ||
                    !Number.isFinite(Number(v[1])),
                ),
            )
          )
            throw new Error("Metric scope or samples invalid");
          data.data.result = series;
          evidence = {
            id: randomUUID(),
            kind: "metric",
            title: ref.title,
            origin: "queried",
            capturedAt: iso(),
            scope: `${from}..${to}`,
            data,
            limitations: [
              "Configured local lab datasource only; no causal runtime mapping.",
            ],
          };
        }
        const bytes = Buffer.byteLength(JSON.stringify(evidence));
        if (controller.signal.aborted || get(i.id)?.status !== "running")
          throw new Error("Late result discarded");
        // Telemetry response bytes were charged while streaming; source evidence is charged after serialization.
        if (ref.kind === "source") charge(bytes);
        i.evidence.push(evidence);
        save(i);
        emit(i);
        return evidence;
      } finally {
        active--;
      }
    };
    try {
      const finding = await options.agent.run(
        {
          question: i.question,
          references: i.references,
          signal: controller.signal,
          read,
        },
        (a, b) => {
          if (!controller.signal.aborted) {
            i.usage.inputTokens = a;
            i.usage.outputTokens = b;
            save(i);
          }
        },
      );
      if (controller.signal.aborted) return;
      const checked = presentFinding(finding, i.evidence);
      if (checked.status !== "valid") throw new Error("Invalid finding");
      i.finding = {
        ...checked.finding,
        strength:
          checked.finding.strength === "supported"
            ? "hypothesis"
            : checked.finding.strength,
        limitations: [
          ...checked.finding.limitations,
          "Selected source is user-supplied and does not establish runtime execution or causation.",
          "This adapter has no runtime-to-code link; causal explanations remain hypotheses.",
        ],
      };
      i.status = "completed";
      i.usage.elapsedMs = Date.now() - started;
      save(i);
      emit(i);
    } catch {
      if (!controller.signal.aborted)
        stop(
          i,
          "failed",
          "Agent or evidence read failed; final answer unavailable.",
        );
    } finally {
      clearTimeout(timer);
      runs.delete(i.id);
    }
  }
  const attempts = new Map<string, { count: number; until: number }>();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`)
        throw new HttpError(403, "host", "Host denied");
      const pathname = new URL(req.url ?? "/", options.origin).pathname;
      if (req.headers.origin && req.headers.origin !== options.origin)
        throw new HttpError(403, "origin", "Origin denied");
      if (req.method === "GET" && staticFiles.has(pathname)) {
        const asset = staticFiles.get(pathname)!;
        res.writeHead(200, {
          "Content-Type": asset.type,
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "Referrer-Policy": "no-referrer",
        });
        res.end(asset.bytes);
        return;
      }
      const mutate = !["GET", "HEAD"].includes(req.method ?? "GET");
      if (
        mutate &&
        (req.headers.origin !== options.origin ||
          !(pathname === "/api/transcriptions"
            ? /^audio\/(webm|ogg|wav)(?:;.*)?$/.test(
                req.headers["content-type"] ?? "",
              )
            : req.headers["content-type"]?.startsWith("application/json")))
      )
        throw new HttpError(403, "origin", "Same-origin JSON required");
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (pathname === "/api/session" && req.method === "POST") {
        const key = req.socket.remoteAddress ?? "local";
        const attempt = attempts.get(key);
        if (attempt && attempt.until > Date.now() && attempt.count >= 5)
          throw new HttpError(429, "login", "Try again later");
        const b = await body(req);
        const token =
          record(b) && typeof b.token === "string" && b.token.length <= 256
            ? b.token
            : "";
        const digest = Buffer.from(hash(token), "hex");
        let user: { id: string; name: string } | undefined;
        for (const row of db
          .prepare("SELECT id,name,token_hash FROM users")
          .all() as { id: string; name: string; token_hash: string }[]) {
          if (
            timingSafeEqual(digest, Buffer.from(row.token_hash, "hex")) &&
            options.users.some((u) => u.id === row.id)
          )
            user = row;
        }
        if (!user) {
          attempts.set(key, {
            count:
              (attempt && attempt.until > Date.now() ? attempt.count : 0) + 1,
            until: Date.now() + 60000,
          });
          throw new HttpError(401, "auth", "Invalid access token");
        }
        attempts.delete(key);
        const session = randomBytes(32).toString("base64url");
        db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
          hash(session),
          user.id,
          Date.now() + (options.sessionMs ?? 3600000),
        );
        res.setHeader(
          "Set-Cookie",
          `simurgh_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((options.sessionMs ?? 3600000) / 1000)}`,
        );
        json(200, { user: { id: user.id, name: user.name } });
        return;
      }
      const cookie =
        req.headers.cookie
          ?.split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith("simurgh_session="))
          ?.slice(16) ?? "";
      const session = db
        .prepare(
          "SELECT user_id,expires FROM sessions WHERE hash=? AND expires>?",
        )
        .get(hash(cookie), Date.now()) as
        | { user_id: string; expires: number }
        | undefined;
      if (!session || !options.users.some((u) => u.id === session.user_id))
        throw new HttpError(401, "auth", "Sign in required");
      const user = session.user_id;
      if (
        (pathname === "/api/transcriptions" ||
          /^\/api\/investigations\/[^/]+\/speech$/.test(pathname)) &&
        req.method === "POST"
      ) {
        if (!options.voice)
          throw new HttpError(
            503,
            "voice",
            "Local voice is not configured. Run optional voice setup.",
          );
        if (voiceBusy)
          throw new HttpError(
            409,
            "voice_busy",
            "Local voice is busy. Try again when the current operation finishes.",
          );
        let ids: string[] = [];
        let item: InvestigationRecord | undefined;
        if (pathname === "/api/transcriptions") {
          const header = req.headers["x-simurgh-reference-ids"];
          if (typeof header !== "string" || header.length > 1024)
            throw new HttpError(
              422,
              "references",
              "Choose one to four owned references",
            );
          try {
            ids = JSON.parse(header);
          } catch {
            throw new HttpError(
              422,
              "references",
              "Invalid reference metadata",
            );
          }
          if (
            !Array.isArray(ids) ||
            ids.length < 1 ||
            ids.length > 4 ||
            new Set(ids).size !== ids.length ||
            !ids.every(
              (id) =>
                typeof id === "string" &&
                !!db
                  .prepare("SELECT 1 FROM refs WHERE id=? AND owner=?")
                  .get(id, user),
            )
          )
            throw new HttpError(
              422,
              "references",
              "References are unavailable",
            );
        } else {
          item = requireItem(pathname.split("/")[3], user);
          if (!item.finding?.summary)
            throw new HttpError(
              409,
              "finding",
              "This investigation has no finding to speak",
            );
        }
        const controller = new AbortController();
        const operation = {
          user,
          id: item?.id,
          sessionHash: hash(cookie),
          controller,
        };
        voiceRuns.add(operation);
        voiceBusy = true;
        const validSession = () =>
          !!db
            .prepare("SELECT 1 FROM sessions WHERE hash=? AND expires>?")
            .get(hash(cookie), Date.now());
        const disconnected = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.once("close", disconnected);
        req.once("aborted", disconnected);
        const deadline = setTimeout(() => controller.abort(), 15000);
        const stopUpload = () => {
          if (!req.complete) req.destroy();
        };
        controller.signal.addEventListener("abort", stopUpload, { once: true });
        try {
          if (item) {
            const payload = await body(req);
            if (!record(payload) || Object.keys(payload).length)
              throw new HttpError(
                422,
                "speech",
                "Speech uses only the saved finding; submit an empty object",
              );
            if (controller.signal.aborted) throw new Error("Cancelled");
            const truncated = item.finding!.summary.length > 1000;
            const audio = await options.voice.speech(
              item.finding!.summary.slice(0, 1000),
              controller.signal,
            );
            requireItem(item.id, user);
            if (controller.signal.aborted || !validSession())
              throw new Error("Cancelled");
            if (audio.length > 4 * 1024 * 1024)
              throw new HttpError(413, "voice_size", "Speech output too large");
            res.writeHead(200, {
              "Content-Type": "audio/wav",
              "X-Simurgh-Audio-Truncated": String(truncated),
            });
            res.end(audio);
          } else {
            const audio = await binaryBody(req, 2 * 1024 * 1024);
            if (controller.signal.aborted) throw new Error("Cancelled");
            const text = await options.voice.transcribe(
              audio,
              controller.signal,
            );
            if (
              controller.signal.aborted ||
              !validSession() ||
              !ids.every(
                (id) =>
                  !!db
                    .prepare("SELECT 1 FROM refs WHERE id=? AND owner=?")
                    .get(id, user),
              )
            )
              throw new Error("Cancelled");
            json(200, { text, referenceIds: ids });
          }
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(
            503,
            "voice",
            "Local audio processing failed or was cancelled. Check the local provider and audio format.",
          );
        } finally {
          clearTimeout(deadline);
          voiceRuns.delete(operation);
          voiceBusy = false;
          res.off("close", disconnected);
          req.off("aborted", disconnected);
          controller.signal.removeEventListener("abort", stopUpload);
        }
        return;
      }
      if (pathname === "/api/session") {
        if (req.method === "DELETE") {
          db.prepare("DELETE FROM sessions WHERE hash=?").run(hash(cookie));
          for (const operation of voiceRuns)
            if (operation.sessionHash === hash(cookie))
              operation.controller.abort();
          for (const s of streams)
            if (s.user === user) {
              s.res.end();
              streams.delete(s);
            }
          res.setHeader(
            "Set-Cookie",
            "simurgh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          res.writeHead(204);
          res.end();
          return;
        }
        json(200, {
          user: options.users.find((u) => u.id === user) && {
            id: user,
            name: options.users.find((u) => u.id === user)!.name,
          },
        });
        return;
      }
      if (pathname === "/api/config") {
        json(200, {
          users: options.users.map(({ id, name }) => ({ id, name })),
          limits,
          capabilities: {
            agent: !!options.agent,
            voice: !!options.voice,
            speech: !!options.voice,
          },
          limitations: [
            "Local lab authorization only.",
            "Model tokens are reported accounting; no hard dollar cap.",
            options.voice
              ? "Local CPU voice provider configured."
              : "Voice transcription unavailable.",
          ],
        });
        return;
      }
      if (pathname === "/api/references") {
        if (req.method === "GET") {
          json(200, {
            references: (
              db
                .prepare("SELECT payload FROM refs WHERE owner=?")
                .all(user) as { payload: string }[]
            ).map((r) => JSON.parse(r.payload)),
          });
          return;
        }
        if (req.method === "POST") {
          const b = await body(req);
          const preview = await previewImportedSnapshot(
            record(b) ? b.snapshot : null,
          );
          if (!preview.ok) throw new HttpError(422, "snapshot", preview.reason);
          if (preview.value.kind === "source") {
            const checked = validateSourceSnapshot(preview.value.snapshot);
            if (!checked.ok) throw new HttpError(422, "source", checked.reason);
          }
          if (preview.value.kind === "telemetry")
            await validateTelemetry(preview.value.snapshot as ConfirmedCapture);
          const ref: WorkspaceReference = {
            id: randomUUID(),
            kind: preview.value.kind,
            title: preview.value.title,
            createdAt: iso(),
            snapshot: preview.value.snapshot,
            limitations: [
              ...preview.value.limitations,
              "Imported data is user-supplied.",
            ],
          };
          db.prepare("INSERT INTO refs VALUES(?,?,?,?)").run(
            ref.id,
            user,
            Date.now(),
            JSON.stringify(ref),
          );
          json(201, { reference: ref });
          return;
        }
      }
      const refMatch = pathname.match(/^\/api\/references\/([^/]+)$/);
      if (refMatch && req.method === "DELETE") {
        if (
          !db
            .prepare("SELECT 1 FROM refs WHERE id=? AND owner=?")
            .get(refMatch[1], user)
        )
          throw new HttpError(404, "not_found", "Resource unavailable");
        for (const row of db
          .prepare("SELECT payload FROM investigations")
          .all() as { payload: string }[]) {
          const i: InvestigationRecord = JSON.parse(row.payload);
          if (
            ["running", "queued"].includes(i.status) &&
            i.referenceIds.includes(refMatch[1])
          )
            throw new HttpError(409, "active", "Reference is in use");
        }
        db.prepare("DELETE FROM refs WHERE id=?").run(refMatch[1]);
        res.writeHead(204);
        res.end();
        return;
      }
      if (pathname === "/api/investigations") {
        if (req.method === "GET") {
          json(200, {
            investigations: (
              db.prepare("SELECT id FROM investigations").all() as {
                id: string;
              }[]
            )
              .map((r) => get(r.id)!)
              .filter((i) => can(i, user))
              .map((i) => requireItem(i.id, user)),
          });
          return;
        }
        if (req.method === "POST") {
          const b = await body(req);
          if (
            !record(b) ||
            typeof b.question !== "string" ||
            !Array.isArray(b.referenceIds) ||
            !b.referenceIds.every((id) => typeof id === "string")
          )
            throw new HttpError(
              422,
              "submission",
              "Invalid question or references",
            );
          const rows = db
            .prepare("SELECT id,payload FROM refs WHERE owner=?")
            .all(user) as { id: string; payload: string }[];
          if (b.referenceIds.some((id) => !rows.some((r) => r.id === id)))
            throw new HttpError(404, "not_found", "Resource unavailable");
          let submission;
          try {
            submission = createInvestigationSubmission(
              b.question,
              b.referenceIds,
              rows.map((r) => r.id),
            );
          } catch {
            throw new HttpError(
              422,
              "submission",
              "Invalid question or references",
            );
          }
          if (runs.size >= limits.concurrency)
            throw new HttpError(409, "busy", "Investigation capacity reached");
          const i: InvestigationRecord = {
            id: randomUUID(),
            ownerId: user,
            question: submission.question,
            referenceIds: [...submission.referenceIds],
            references: submission.referenceIds.map((id) =>
              JSON.parse(rows.find((r) => r.id === id)!.payload),
            ),
            createdAt: iso(),
            status: options.agent ? "queued" : "failed",
            stopReason: options.agent
              ? null
              : "Codex adapter unavailable: account and isolation qualification required.",
            limits,
            usage: {
              elapsedMs: 0,
              queries: 0,
              bytes: 0,
              inputTokens: null,
              outputTokens: null,
              modelUsageEnforcement:
                "Observed token usage only; no preemptive billing cap.",
            },
            evidence: [],
            finding: null,
            grants: [],
            limitations: ["No runtime-to-source causal mapping."],
          };
          db.prepare("INSERT INTO investigations VALUES(?,?,?,?)").run(
            i.id,
            user,
            Date.now(),
            JSON.stringify(i),
          );
          json(202, { investigation: i });
          void run(i);
          return;
        }
      }
      const match = pathname.match(
        /^\/api\/investigations\/([^/]+)(?:\/(cancel|grants|export|events))?$/,
      );
      if (match) {
        const [, id, action] = match;
        const owner = req.method !== "GET";
        const i = requireItem(id, user, owner);
        if (action === "events" && req.method === "GET") {
          if (streams.size >= 32)
            throw new HttpError(429, "streams", "Event capacity reached");
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
          });
          const s = { id, user, expires: session.expires, res };
          streams.add(s);
          req.on("close", () => streams.delete(s));
          res.write(
            `event: investigation\ndata: ${JSON.stringify({ investigation: i })}\n\n`,
          );
          return;
        }
        if (action === "grants" && req.method === "PUT") {
          const b = await body(req);
          if (
            !record(b) ||
            !Array.isArray(b.userIds) ||
            b.userIds.length > options.users.length ||
            !b.userIds.every(
              (id) =>
                typeof id === "string" &&
                options.users.some((u) => u.id === id),
            ) ||
            new Set(b.userIds).size !== b.userIds.length
          )
            throw new HttpError(422, "grants", "Invalid principals");
          db.transaction(() => {
            db.prepare("DELETE FROM grants WHERE item=?").run(id);
            for (const principal of b.userIds as string[])
              db.prepare("INSERT INTO grants VALUES(?,?)").run(id, principal);
          })();
          for (const operation of voiceRuns)
            if (operation.id === id && !can(i, operation.user))
              operation.controller.abort();
          emit(i);
          json(200, { investigation: requireItem(id, user) });
          return;
        }
        if (action === "cancel" && req.method === "POST") {
          await body(req);
          stop(i, "cancelled", "Cancelled by owner");
          json(200, { investigation: requireItem(id, user) });
          return;
        }
        if (req.method === "DELETE" && !action) {
          for (const operation of voiceRuns)
            if (operation.id === id) operation.controller.abort();
          stop(i, "cancelled", "Deleted by owner");
          for (const s of streams)
            if (s.id === id) {
              s.res.end();
              streams.delete(s);
            }
          db.prepare("DELETE FROM investigations WHERE id=?").run(id);
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "GET" && (!action || action === "export")) {
          json(200, { investigation: i });
          return;
        }
      }
      throw new HttpError(404, "not_found", "Resource unavailable");
    } catch (e) {
      if (!res.headersSent) {
        const error =
          e instanceof HttpError
            ? e
            : new HttpError(500, "internal", "Request failed");
        res.writeHead(error.status, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: error.code, message: error.message },
          }),
        );
      } else res.end();
    }
  });
  return {
    server,
    get url() {
      const address = server.address();
      return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 4317}`;
    },
    listen: (port = 4317) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      }),
    close: async () => {
      clearInterval(cleanup);
      for (const operation of voiceRuns) operation.controller.abort();
      for (const [id] of runs) {
        const i = get(id);
        if (i) stop(i, "cancelled", "Coordinator stopped");
      }
      for (const s of streams) s.res.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
async function binaryBody(req: IncomingMessage, max: number): Promise<Buffer> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max)
      throw new HttpError(413, "audio_size", "Audio must be 2 MiB or smaller");
    chunks.push(chunk);
  }
  if (!bytes)
    throw new HttpError(422, "audio", "Record audio before transcribing");
  return Buffer.concat(chunks);
}
async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5_100_000) throw new HttpError(413, "size", "Request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "json", "Invalid JSON");
  }
}
async function boundedJson(
  res: Response,
  max: number,
  charge: (bytes: number) => void,
): Promise<unknown> {
  if (!res.body) throw new Error("Datasource unavailable");
  const reader = res.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      charge(next.value.byteLength);
      if (size > max) throw new Error("Data budget reached");
      chunks.push(next.value);
    }
    if (!res.ok) throw new Error("Datasource unavailable");
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}
