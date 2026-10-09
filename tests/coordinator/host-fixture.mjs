#!/usr/bin/env node
// Synthetic protocol executable. Never used by production startup.
import { createInterface } from "node:readline";
import { basename } from "node:path";
const mode = basename(process.cwd());
if (
  process.argv.includes("code_mode_host") ||
  !process.argv.includes("features.code_mode.enabled=false")
)
  process.exit(9);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (m, result) => send({ id: m.id, result });
let calls = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    if (mode === "null") {
      process.stdout.write("null\n");
      return;
    }
    if (mode === "primitive") {
      process.stdout.write("42\n");
      return;
    }
    if (mode === "hang-init") return;
    reply(m, {
      userAgent: `fixture/${mode === "version" ? "0.1.0" : "0.160.0"}`,
    });
  } else if (m.method === "mcpServerStatus/list")
    reply(m, {
      data: mode === "mcp" ? [{ name: "untrusted" }] : [],
      nextCursor: null,
    });
  else if (m.method === "thread/start") {
    if (mode === "auth") {
      send({ id: m.id, error: { code: 1, message: "Login required" } });
      return;
    }
    reply(m, {
      thread: { id: "thread" },
      instructionSources:
        mode === "instructions" ? ["/untrusted/AGENTS.md"] : [],
    });
  } else if (m.method === "turn/start") {
    if (mode === "exit") {
      process.exit(2);
      return;
    }
    if (mode === "hang-turn") return;
    reply(m, { turn: { id: "turn" } });
    send({
      method: "item/started",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { type: "userMessage" },
      },
    });
    if (mode === "native" || mode === "approval") {
      send({
        id: 50,
        method:
          mode === "native"
            ? "item/commandExecution/requestApproval"
            : "item/fileChange/requestApproval",
        params: { threadId: "thread", turnId: "turn" },
      });
      return;
    }
    if (mode === "output") {
      process.stdout.write("x".repeat(1100000));
      return;
    }
    if (mode === "hang") return;
    const requests =
      mode === "badcalls"
        ? [
            ["wrong-thread", "turn", "simurgh_read_evidence", "c1", {}],
            ["thread", "wrong-turn", "simurgh_read_evidence", "c2", {}],
            ["thread", "turn", "arbitrary_http", "c3", {}],
            [
              "thread",
              "turn",
              "simurgh_read_evidence",
              "c4",
              { referenceId: "ref", window: "selected", url: "http://evil" },
            ],
            [
              "thread",
              "turn",
              "simurgh_read_evidence",
              "valid",
              { referenceId: "ref", window: "selected" },
            ],
            [
              "thread",
              "turn",
              "simurgh_read_evidence",
              "valid",
              { referenceId: "ref", window: "selected" },
            ],
          ]
        : [
            [
              "thread",
              "turn",
              "simurgh_read_evidence",
              "valid",
              { referenceId: "ref", window: "selected" },
            ],
          ];
    for (const [threadId, turnId, tool, callId, args] of requests)
      send({
        id: 100 + calls++,
        method: "item/tool/call",
        params: { threadId, turnId, tool, callId, arguments: args },
      });
  } else if (m.id >= 100 && m.result?.success) {
    const evidence = JSON.parse(m.result.contentItems[0].text);
    send({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          type: "agentMessage",
          text: JSON.stringify({
            strength: "hypothesis",
            summary: "Fixture",
            citations: [evidence.id],
            limitations: [],
            nextCheck: "Check",
          }),
        },
      },
    });
    send({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
    });
  }
});
