#!/usr/bin/env node
// Sends an MCP `initialize` + `tools/list` over stdio and prints the tool count.
// Run: node scripts/smoke-test.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "../dist/index.js");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, OBSIDIAN_CLI: process.env.OBSIDIAN_CLI ?? "obsidian" },
});

let stdoutBuf = "";
const responses = new Map();

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && responses.has(msg.id)) {
        responses.get(msg.id)(msg);
      }
    } catch {
      // ignore non-JSON
    }
  }
});

child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

function send(id, method, params) {
  return new Promise((resolveResp, reject) => {
    responses.set(id, resolveResp);
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    child.stdin.write(req, (err) => {
      if (err) reject(err);
    });
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
  });
}

try {
  const init = await send(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  console.log("initialize OK ->", init.result?.serverInfo);

  // Required notification after initialize.
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await send(2, "tools/list", {});
  const list = tools.result?.tools ?? [];
  console.log(`tools/list OK -> ${list.length} tools`);
  for (const t of list) console.log(`  - ${t.name}: ${t.title ?? ""}`);

  child.kill();
  process.exit(0);
} catch (err) {
  console.error("smoke test failed:", err);
  child.kill();
  process.exit(1);
}
