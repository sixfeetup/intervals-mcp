import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SERVER_PATH = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));

const EXPECTED_TOOL_NAMES = [
  "find_project_context", "start_timer", "stop_timer", "edit_timer", "delete_timer",
  "add_time", "edit_time", "delete_time", "query_time", "list_timers",
  "lookup_time_entry", "list_time", "set_project_defaults", "sync_now",
];

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

function startServer(home: string): {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params?: unknown): Promise<JsonRpcMessage>;
  notify(method: string, params?: unknown): void;
  rawStdout(): string;
} {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      INTERVALS_HOME: home,
      INTERVALS_API_KEY: "",
      INTERVALS_BASE_URL: "",
      INTERVALS_PERSON_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  let buffer = "";
  let raw = "";
  const pending = new Map<number, (message: JsonRpcMessage) => void>();

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    raw += text;
    buffer += text;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line) as JsonRpcMessage;
      if (message.id != null) pending.get(message.id)?.(message);
    }
  });

  return {
    child,
    request(method, params) {
      const id = nextId++;
      const promise = new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return promise;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    rawStdout: () => raw,
  };
}

test("MCP stdio server: initialize → tools/list → tools/call, byte-clean stdout", async () => {
  assert.ok(existsSync(SERVER_PATH), "dist/server.mjs is missing — run `npm run build` first");
  const home = mkdtempSync(join(tmpdir(), "intervals-mcp-smoke-"));
  const server = startServer(home);
  try {
    const init = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    });
    assert.ok(init.result, "initialize returns a result");
    server.notify("notifications/initialized");

    const list = await server.request("tools/list");
    const tools = (list.result as { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> }).tools;
    assert.equal(tools.length, 14);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOL_NAMES].sort());
    for (const t of tools) {
      assert.ok(t.description.length > 0);
      assert.equal(t.inputSchema.type, "object");
    }

    const call = await server.request("tools/call", {
      name: "find_project_context",
      arguments: { query: "no-such-project" },
    });
    const callResult = call.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.notEqual(callResult.isError, true);
    assert.equal(callResult.content[0].text, "No projects found.");

    const bad = await server.request("tools/call", {
      name: "lookup_time_entry",
      arguments: { timer_id: "missing" },
    });
    const badResult = bad.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(badResult.isError, true, "domain errors surface as isError results, not JSON-RPC errors");
    assert.match(badResult.content[0].text, /no time entry linked to timer/);

    const invalid = await server.request("tools/call", {
      name: "query_time",
      arguments: { range: "not-a-range" },
    });
    const invalidResult = invalid.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(invalidResult.isError, true);
    assert.match(invalidResult.content[0].text, /invalid arguments for query_time/);

    // stdio hygiene: every stdout line is a parseable JSON-RPC frame, nothing else.
    for (const line of server.rawStdout().split("\n")) {
      if (line === "") continue;
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      assert.equal(parsed.jsonrpc, "2.0", `non-JSON-RPC bytes on stdout: ${line.slice(0, 80)}`);
    }
  } finally {
    server.child.stdin.end();
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        server.child.kill("SIGKILL");
        resolve();
      }, 3_000);
      server.child.on("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
    rmSync(home, { recursive: true, force: true });
  }
});
