import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCoordinator } from "../../packages/coordinator/src/server";

const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
const source = () => ({
  schema: "simurgh.source",
  version: 1,
  editor: "vscode",
  captureId: "a1000000-0000-4000-8000-000000000000",
  capturedAt: new Date().toISOString(),
  document: {
    uri: "file:///lab/a.ts",
    languageId: "typescript",
    version: 1,
    dirty: false,
    contentHash: createHash("sha256").update("const a = 1;").digest("hex"),
  },
  workspace: null,
  symbols: [],
  definitions: [],
  selection: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 12 },
    text: "const a = 1;",
  },
  limitations: ["No runtime mapping."],
});
describe("coordinator HTTP permission boundary", () => {
  it("revokes removed principals and rotated sessions on restart and rejects incomplete limits or duplicate tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "simurgh-principals-"));
    dirs.push(dir);
    const options = {
      databasePath: join(dir, "db"),
      origin: "http://127.0.0.1:4317",
      users: [
        { id: "alice", name: "Alice", token: "a".repeat(64) },
        { id: "bob", name: "Bob", token: "b".repeat(64) },
      ],
    };
    let app = createCoordinator(options);
    await app.listen(0);
    const login = async (token: string) =>
      fetch(app.url + "/api/session", {
        method: "POST",
        headers: { Origin: options.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    const alice = (await login(options.users[0].token)).headers
      .get("set-cookie")!
      .split(";")[0];
    const bob = (await login(options.users[1].token)).headers
      .get("set-cookie")!
      .split(";")[0];
    await app.close();
    app = createCoordinator({
      ...options,
      users: [{ id: "alice", name: "Alice", token: "c".repeat(64) }],
    });
    await app.listen(0);
    expect(
      (await fetch(app.url + "/api/session", { headers: { Cookie: alice } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(app.url + "/api/session", { headers: { Cookie: bob } }))
        .status,
    ).toBe(401);
    expect((await login("b".repeat(64))).status).toBe(401);
    expect((await login("a".repeat(64))).status).toBe(401);
    await app.close();
    expect(() => createCoordinator({ ...options, limits: {} as any })).toThrow(
      "limits",
    );
    expect(() =>
      createCoordinator({
        ...options,
        users: options.users.map((u) => ({ ...u, token: "a".repeat(64) })),
      }),
    ).toThrow("Distinct");
  });
  it("rejects forged source hashes and bounds completed findings to evidence-backed hypotheses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "simurgh-finding-"));
    dirs.push(dir);
    const app = createCoordinator({
      databasePath: join(dir, "db"),
      origin: "http://127.0.0.1:4317",
      users: [{ id: "alice", name: "Alice", token: "a".repeat(64) }],
      agent: {
        run: async (input) => {
          const e = await input.read(input.references[0].id, "selected");
          return {
            strength: "supported",
            summary: "Observed selected code",
            citations: [e.id],
            limitations: [],
            nextCheck: "Collect profiles",
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
    const cookie = (
      await request("/api/session", "POST", { token: "a".repeat(64) })
    ).headers
      .get("set-cookie")!
      .split(";")[0];
    const forged = source();
    forged.document.contentHash = "0".repeat(64);
    expect(
      (await request("/api/references", "POST", { snapshot: forged }, cookie))
        .status,
    ).toBe(422);
    const provenance = {
      ...source(),
      document: { ...source().document, dirty: true },
      workspace: {
        name: "Lab",
        rootUri: "file:///lab",
        relativePath: "a.ts",
        gitRevision: "a".repeat(40),
      },
    };
    const ref = (
      await (
        await request(
          "/api/references",
          "POST",
          { snapshot: provenance },
          cookie,
        )
      ).json()
    ).reference;
    const inv = (
      await (
        await request(
          "/api/investigations",
          "POST",
          { question: "Explain source", referenceIds: [ref.id] },
          cookie,
        )
      ).json()
    ).investigation;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const done = (
      await (
        await request(`/api/investigations/${inv.id}`, "GET", undefined, cookie)
      ).json()
    ).investigation;
    expect(done.status).toBe("completed");
    expect(done.evidence[0].data.document.dirty).toBe(true);
    expect(done.evidence[0].data.document.contentHash).toBe(
      provenance.document.contentHash,
    );
    expect(done.evidence[0].data.workspace.gitRevision).toBe("a".repeat(40));
    expect(done.finding.strength).toBe("hypothesis");
    expect(done.finding.citations).toEqual([done.evidence[0].id]);
    expect(done.finding.limitations.join(" ")).toContain(
      "no runtime-to-code link",
    );
    await app.close();
  });
  it("bounds source reads, rejects unknown tool references, and discards late output after cancellation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "simurgh-run-"));
    dirs.push(dir);
    let read!: (id: string, window: "selected" | "baseline") => Promise<any>;
    let finish!: (value: any) => void;
    const app = createCoordinator({
      databasePath: join(dir, "db"),
      origin: "http://127.0.0.1:4317",
      users: [{ id: "alice", name: "Alice", token: "a".repeat(64) }],
      limits: { wallMs: 10000, queries: 2, bytes: 4096, concurrency: 1 },
      agent: {
        run: async (input) => {
          read = input.read;
          return await new Promise((resolve) => {
            finish = resolve;
          });
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
    const cookie = (
      await request("/api/session", "POST", { token: "a".repeat(64) })
    ).headers
      .get("set-cookie")!
      .split(";")[0];
    const ref = (
      await (
        await request("/api/references", "POST", { snapshot: source() }, cookie)
      ).json()
    ).reference;
    const inv = (
      await (
        await request(
          "/api/investigations",
          "POST",
          { question: "Explain source", referenceIds: [ref.id] },
          cookie,
        )
      ).json()
    ).investigation;
    await expect(read("unknown", "selected")).rejects.toThrow(
      "Unknown reference",
    );
    const evidence = await read(ref.id, "selected");
    expect(evidence.origin).toBe("user-supplied");
    expect(evidence.data.text).toBe("const a = 1;");
    await expect(read(ref.id, "selected")).rejects.toThrow("budget");
    const limited = (
      await (
        await request(`/api/investigations/${inv.id}`, "GET", undefined, cookie)
      ).json()
    ).investigation;
    expect(limited.status).toBe("limited");
    expect(limited.usage.queries).toBe(2);
    finish({
      strength: "supported",
      summary: "Late",
      citations: [evidence.id],
      limitations: [],
      nextCheck: "Check",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = (
      await (
        await request(
          "/api/investigations",
          "POST",
          { question: "Cancel source", referenceIds: [ref.id] },
          cookie,
        )
      ).json()
    ).investigation;
    await request(
      `/api/investigations/${second.id}/cancel`,
      "POST",
      {},
      cookie,
    );
    await expect(read(ref.id, "selected")).rejects.toThrow("stopped");
    finish({
      strength: "inconclusive",
      summary: "Late",
      citations: [],
      limitations: [],
      nextCheck: "Check",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cancelled = (
      await (
        await request(
          `/api/investigations/${second.id}`,
          "GET",
          undefined,
          cookie,
        )
      ).json()
    ).investigation;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finding).toBeNull();
    await app.close();
  });
  it("authenticates two principals, persists private imports and grants, revokes export and deletes across restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "simurgh-test-"));
    dirs.push(dir);
    const options = {
      databasePath: join(dir, "db.sqlite"),
      origin: "http://127.0.0.1:4317",
      users: [
        { id: "alice", name: "Alice", token: "a".repeat(64) },
        { id: "bob", name: "Bob", token: "b".repeat(64) },
      ],
    };
    let app = createCoordinator(options);
    await app.listen(0);
    let url = app.url;
    const request = async (
      path: string,
      method = "GET",
      body?: unknown,
      cookie = "",
    ) =>
      fetch(url + path, {
        method,
        headers: {
          Origin: options.origin,
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect((await request("/api/config")).status).toBe(401);
    const login = await request("/api/session", "POST", {
      token: options.users[0].token,
    });
    const alice = login.headers.get("set-cookie")!.split(";")[0];
    const bob = (
      await request("/api/session", "POST", { token: options.users[1].token })
    ).headers
      .get("set-cookie")!
      .split(";")[0];
    expect(
      (
        await fetch(url + "/api/references", {
          method: "POST",
          headers: {
            Origin: "http://evil.invalid",
            "Content-Type": "application/json",
            Cookie: alice,
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const ref = (
      await (
        await request("/api/references", "POST", { snapshot: source() }, alice)
      ).json()
    ).reference;
    expect(
      (await (await request("/api/references", "GET", undefined, bob)).json())
        .references,
    ).toEqual([]);
    expect(
      (
        await request(
          "/api/investigations",
          "POST",
          { question: "Explain", referenceIds: [ref.id] },
          bob,
        )
      ).status,
    ).toBe(404);
    const inv = (
      await (
        await request(
          "/api/investigations",
          "POST",
          { question: "Explain", referenceIds: [ref.id] },
          alice,
        )
      ).json()
    ).investigation;
    expect(
      (
        await request(
          `/api/investigations/${inv.id}/export`,
          "GET",
          undefined,
          bob,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/investigations/${inv.id}/grants`,
          "PUT",
          { userIds: ["bob"] },
          alice,
        )
      ).status,
    ).toBe(200);
    const streamAbort = new AbortController();
    const stream = await fetch(url + `/api/investigations/${inv.id}/events`, {
      headers: { Cookie: bob },
      signal: streamAbort.signal,
    });
    const reader = stream.body!.getReader();
    let initial = "";
    while (!initial.endsWith("\n\n")) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      initial += new TextDecoder().decode(chunk.value);
    }
    expect(initial).toContain("event: investigation");
    await request(
      `/api/investigations/${inv.id}/grants`,
      "PUT",
      { userIds: [] },
      alice,
    );
    expect((await reader.read()).done).toBe(true);
    streamAbort.abort();
    await request(
      `/api/investigations/${inv.id}/grants`,
      "PUT",
      { userIds: ["bob"] },
      alice,
    );
    expect(
      (
        await request(
          `/api/investigations/${inv.id}/export`,
          "GET",
          undefined,
          bob,
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(`/api/investigations/${inv.id}/cancel`, "POST", {}, bob))
        .status,
    ).toBe(404);
    await app.close();
    app = createCoordinator(options);
    await app.listen(0);
    url = app.url;
    expect(
      (await request(`/api/investigations/${inv.id}`, "GET", undefined, bob))
        .status,
    ).toBe(200);
    await request(
      `/api/investigations/${inv.id}/grants`,
      "PUT",
      { userIds: [] },
      alice,
    );
    expect(
      (
        await request(
          `/api/investigations/${inv.id}/events`,
          "GET",
          undefined,
          bob,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/investigations/${inv.id}`,
          "DELETE",
          undefined,
          alice,
        )
      ).status,
    ).toBe(204);
    await app.close();
    app = createCoordinator(options);
    await app.listen(0);
    url = app.url;
    expect(
      (await request(`/api/investigations/${inv.id}`, "GET", undefined, alice))
        .status,
    ).toBe(404);
    await app.close();
  });
});
