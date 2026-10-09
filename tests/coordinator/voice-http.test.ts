import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCoordinator } from "../../packages/coordinator/src/server";
it("authenticates binary transcription, freezes owned references, permits shared finding speech and aborts revoke", async () => {
  const dir = mkdtempSync(join(tmpdir(), "simurgh-voice-http-"));
  let speechSignal: AbortSignal | undefined;
  let release!: (wave: Buffer) => void;
  let slow = false;
  const app = createCoordinator({
    databasePath: join(dir, "db"),
    origin: "http://127.0.0.1:4317",
    users: [
      { id: "alice", name: "Alice", token: "a".repeat(64) },
      { id: "bob", name: "Bob", token: "b".repeat(64) },
    ],
    voice: {
      transcribe: async () => "Synthetic transcript",
      speech: async (_text, signal) => {
        speechSignal = signal;
        if (slow)
          return await new Promise((resolve) => {
            release = resolve;
          });
        return Buffer.from("fixture-wave");
      },
    },
    agent: {
      run: async () => ({
        strength: "inconclusive",
        summary: "Finding only",
        citations: [],
        limitations: [],
        nextCheck: "Collect evidence",
      }),
    },
  });
  await app.listen(0);
  const json = (path: string, method: string, body: unknown, cookie = "") =>
    fetch(app.url + path, {
      method,
      headers: {
        Origin: "http://127.0.0.1:4317",
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });
  const login = async (token: string) =>
    (await json("/api/session", "POST", { token })).headers
      .get("set-cookie")!
      .split(";")[0];
  const alice = await login("a".repeat(64));
  const bob = await login("b".repeat(64));
  const text = "const a = 1;";
  const source = {
    schema: "simurgh.source",
    version: 1,
    editor: "vscode",
    captureId: "a1000000-0000-4000-8000-000000000000",
    capturedAt: new Date().toISOString(),
    document: {
      uri: "file:///lab/a.ts",
      languageId: "typescript",
      version: 1,
      dirty: true,
      contentHash: createHash("sha256").update(text).digest("hex"),
    },
    workspace: {
      name: "Lab",
      rootUri: "file:///lab",
      relativePath: "a.ts",
      gitRevision: "a".repeat(40),
    },
    selection: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 12 },
      text,
    },
    symbols: [],
    definitions: [],
    limitations: [],
  };
  try {
    const ref = (
      await (
        await json("/api/references", "POST", { snapshot: source }, alice)
      ).json()
    ).reference;
    const transcribe = (
      cookie: string,
      ids: string[],
      bytes = Buffer.from("fixture-audio"),
    ) =>
      fetch(app.url + "/api/transcriptions", {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:4317",
          "Content-Type": "audio/webm;codecs=opus",
          "X-Simurgh-Reference-Ids": JSON.stringify(ids),
          Cookie: cookie,
        },
        body: bytes,
      });
    expect((await transcribe("", [ref.id])).status).toBe(401);
    expect((await transcribe(bob, [ref.id])).status).toBe(422);
    expect(
      (await transcribe(alice, [ref.id], Buffer.alloc(2 * 1024 * 1024 + 1)))
        .status,
    ).toBe(413);
    const transcript = await transcribe(alice, [ref.id]);
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toEqual({
      text: "Synthetic transcript",
      referenceIds: [ref.id],
    });
    const inv = (
      await (
        await json(
          "/api/investigations",
          "POST",
          { question: "Explain", referenceIds: [ref.id] },
          alice,
        )
      ).json()
    ).investigation;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await json(
      `/api/investigations/${inv.id}/grants`,
      "PUT",
      { userIds: ["bob"] },
      alice,
    );
    const spoken = await json(
      `/api/investigations/${inv.id}/speech`,
      "POST",
      {},
      bob,
    );
    expect(spoken.status).toBe(200);
    expect(spoken.headers.get("content-type")).toBe("audio/wav");
    expect(spoken.headers.get("x-simurgh-audio-truncated")).toBe("false");
    slow = true;
    const pending = json(
      `/api/investigations/${inv.id}/speech`,
      "POST",
      {},
      bob,
    );
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await transcribe(alice, [ref.id])).status).toBe(409);
    await json(
      `/api/investigations/${inv.id}/grants`,
      "PUT",
      { userIds: [] },
      alice,
    );
    expect(speechSignal!.aborted).toBe(true);
    release(Buffer.from("late-wave"));
    expect((await pending).status).toBe(404);
    expect(
      (await json(`/api/investigations/${inv.id}/speech`, "POST", {}, bob))
        .status,
    ).toBe(404);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
