#!/usr/bin/env node
// End-to-end test: spawn the MCP server with a fake `obsidian` binary that
// echoes the args it received, and verify the routing layer:
//   1. Unknown topic → MCP sends elicitation/create → we accept with a folder.
//   2. The CLI is invoked with the routed path.
//   3. Subsequent call with same topic uses stored folder, no elicitation.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "../dist/index.js");
const tmpHome = mkdtempSync(join(tmpdir(), "obsidian-mcp-routing-"));

// Build a fake obsidian binary that just prints the args it got.
const fakeBinPath = join(tmpHome, process.platform === "win32" ? "obsidian.cmd" : "obsidian");
if (process.platform === "win32") {
  // On Windows, write a .cmd that echoes received args. Use a Node script
  // wrapped in a .cmd so we don't fight with cmd.exe quoting.
  const nodeScript = join(tmpHome, "fake-obsidian.mjs");
  writeFileSync(
    nodeScript,
    `process.stdout.write("FAKE_CLI_ARGS=" + JSON.stringify(process.argv.slice(2)));`,
    "utf8",
  );
  writeFileSync(fakeBinPath, `@echo off\r\nnode "${nodeScript}" %*\r\n`, "utf8");
} else {
  writeFileSync(
    fakeBinPath,
    `#!/usr/bin/env node\nprocess.stdout.write("FAKE_CLI_ARGS=" + JSON.stringify(process.argv.slice(2)));\n`,
    "utf8",
  );
  chmodSync(fakeBinPath, 0o755);
}

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    OBSIDIAN_CLI: fakeBinPath,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
  },
});

let buf = "";
const responses = new Map();
const elicitations = []; // each item: { id, params, resolve }

child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    // Server-initiated request → handle it (elicitation/create).
    if (msg.method === "elicitation/create") {
      elicitations.push(msg);
      continue;
    }
    if (msg.id !== undefined && responses.has(msg.id)) {
      responses.get(msg.id)(msg);
    }
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));

function rpc(id, method, params) {
  return new Promise((res, rej) => {
    responses.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => rej(new Error(`timeout ${method}`)), 15000);
  });
}

function reply(id, result) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    console.log("✓", label);
    passed++;
  } else {
    console.error("✗", label);
    failed++;
  }
}

async function waitForElicitation(timeoutMs = 5000) {
  const start = Date.now();
  while (elicitations.length === 0) {
    if (Date.now() - start > timeoutMs) throw new Error("elicitation never arrived");
    await new Promise((r) => setTimeout(r, 30));
  }
  return elicitations.shift();
}

try {
  // Initialize WITH elicitation capability.
  await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { elicitation: {} },
    clientInfo: { name: "routing-test", version: "0.0.1" },
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );

  // === Case 1: unknown topic → elicit → user replies with folder ===
  // Kick off the call (don't await yet — we need to handle the elicitation first).
  const callPromise1 = rpc(2, "tools/call", {
    name: "obsidian_create_note",
    arguments: { path: "kungpao.md", topic: "recipe-chinese", vault: "TestVault" },
  });

  const elicit = await waitForElicitation();
  ok(
    elicit.params?.message?.includes("recipe-chinese"),
    "elicitation message mentions the new topic",
  );
  ok(
    elicit.params?.requestedSchema?.properties?.folder?.type === "string",
    "elicitation requestedSchema asks for `folder` string",
  );
  // Reply: user picks "食譜/中式".
  reply(elicit.id, { action: "accept", content: { folder: "食譜/中式" } });

  const r1 = await callPromise1;
  const text1 = r1.result?.content?.map((c) => c.text).join("\n") ?? "";
  ok(/recipe-chinese/.test(text1), "response mentions topic");
  ok(/食譜\/中式/.test(text1), "response shows resolved folder");
  ok(/FAKE_CLI_ARGS/.test(text1), "fake CLI was invoked");
  ok(
    /path=食譜\/中式\/kungpao\.md/.test(text1),
    "CLI received the routed path as `path=` (name= would be rejected by the CLI when it contains '/')",
  );

  // === Case 2: same topic again → store hit, no elicitation ===
  const before = elicitations.length;
  const callPromise2 = rpc(3, "tools/call", {
    name: "obsidian_create_note",
    arguments: { path: "mapo.md", topic: "recipe-chinese", vault: "TestVault" },
  });
  // Give server a moment to (not) elicit.
  await new Promise((r) => setTimeout(r, 200));
  ok(elicitations.length === before, "second call did not elicit");
  const r2 = await callPromise2;
  const text2 = r2.result?.content?.map((c) => c.text).join("\n") ?? "";
  ok(/stored route/.test(text2), "response says route came from store");
  ok(/path=食譜\/中式\/mapo\.md/.test(text2), "second note also routed to 食譜/中式 via path=");

  // === Case 3: explicit path bypasses topic store ===
  const before3 = elicitations.length;
  const callPromise3 = rpc(4, "tools/call", {
    name: "obsidian_create_note",
    arguments: { path: "Special/path.md", topic: "recipe-chinese", vault: "TestVault" },
  });
  await new Promise((r) => setTimeout(r, 200));
  ok(elicitations.length === before3, "explicit path did not trigger elicitation");
  const r3 = await callPromise3;
  const text3 = r3.result?.content?.map((c) => c.text).join("\n") ?? "";
  ok(/explicit path/.test(text3), "response notes explicit path");
  ok(/path=Special\/path\.md/.test(text3), "explicit path preserved and sent via path=");

  // === Case 4: topic_stats reflects what was stored ===
  const r4 = await rpc(5, "tools/call", {
    name: "obsidian_topic_stats",
    arguments: { vault: "TestVault" },
  });
  const sc = r4.result?.structuredContent ?? {};
  ok(sc.totalTopics === 1, "stats: 1 topic registered");
  ok(sc.totalWrites === 2, "stats: 2 total uses (case 1 + case 2)");
  ok(
    sc.topics?.[0]?.topic === "recipe-chinese" && sc.topics[0].folder === "食譜/中式",
    "stats: top topic matches what we stored",
  );

  // === Case 5: strict input — unknown field is rejected (not silently dropped) ===
  // Catches the typical caller mistake of passing `name` (the old field) instead of `path`.
  const r5 = await rpc(6, "tools/call", {
    name: "obsidian_create_note",
    arguments: { name: "legacy.md", vault: "TestVault" },
  });
  const text5 = r5.result?.content?.map((c) => c.text).join("\n") ?? "";
  ok(r5.result?.isError === true, "strict input: response is marked as error");
  ok(/unrecognized_keys|Unrecognized key/i.test(text5), "strict input: error names the violation as unrecognized_keys");
  ok(/"name"|'name'/.test(text5), "strict input: error mentions the offending key 'name'");

  child.kill();
  process.on("exit", () => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error("test crashed:", err);
  child.kill();
  process.exit(2);
}
