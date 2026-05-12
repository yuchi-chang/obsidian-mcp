#!/usr/bin/env node
// Integration test for the confirmation gate.
// Spawns the MCP server, declares NO elicitation capability, then calls a
// sensitive tool — the server should refuse with a "confirm: true" hint.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const serverPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/index.js",
);

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, OBSIDIAN_CLI: "obsidian-not-installed" },
});

let buf = "";
const responses = new Map();
child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && responses.has(msg.id)) {
        responses.get(msg.id)(msg);
      }
    } catch {}
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));

function rpc(id, method, params) {
  return new Promise((res, rej) => {
    responses.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => rej(new Error(`timeout ${method}`)), 10000);
  });
}

let failed = false;
function assert(cond, msg) {
  if (!cond) {
    console.error("✗", msg);
    failed = true;
  } else {
    console.log("✓", msg);
  }
}

try {
  // Initialize WITHOUT elicitation capability.
  await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {}, // no elicitation
    clientInfo: { name: "confirm-test", version: "0.0.1" },
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );

  // Case 1: sensitive tool without confirm → should be refused.
  const r1 = await rpc(2, "tools/call", {
    name: "obsidian_delete_note",
    arguments: { path: "Some/Note.md" },
  });
  assert(r1.result?.isError === true, "delete without confirm returns isError");
  const text1 = r1.result?.content?.[0]?.text ?? "";
  assert(/confirm: true/i.test(text1), "error text mentions confirm: true");
  assert(/elicitation/i.test(text1), "error text mentions elicitation unsupported");

  // Case 2: sensitive tool WITH confirm: true → bypasses gate, runs CLI which fails (binary missing).
  const r2 = await rpc(3, "tools/call", {
    name: "obsidian_delete_note",
    arguments: { path: "Some/Note.md", confirm: true },
  });
  const text2 = r2.result?.content?.[0]?.text ?? "";
  assert(r2.result?.isError === true, "delete with confirm:true still errors (binary missing)");
  assert(
    !/elicitation/i.test(text2),
    "with confirm:true, the elicitation hint is gone — CLI was actually invoked",
  );

  // Case 3: non-sensitive tool without confirm → no gate, just CLI failure.
  const r3 = await rpc(4, "tools/call", {
    name: "obsidian_list_files",
    arguments: {},
  });
  const text3 = r3.result?.content?.[0]?.text ?? "";
  assert(
    !/confirm: true/i.test(text3),
    "non-sensitive tool does not trigger confirm prompt",
  );

  // Case 4: organize_apply with dry_run:true → skipWhen bypasses the gate
  // even without elicitation capability and without confirm:true.
  const r4 = await rpc(5, "tools/call", {
    name: "obsidian_organize_apply",
    arguments: {
      plan: [{ path: "x.md", target_folder: "Test" }],
      dry_run: true,
    },
  });
  const text4 = r4.result?.content?.[0]?.text ?? "";
  assert(
    !/confirm: true/i.test(text4),
    "organize_apply with dry_run:true skips the confirmation gate",
  );

  child.kill();
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error("test crashed:", err);
  child.kill();
  process.exit(2);
}
