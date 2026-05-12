#!/usr/bin/env node
// Unit tests for rootScan helpers + orchestration.
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(
        r.then(
          () => { console.log("✓", name); passed++; },
          (err) => { console.error("✗", name); console.error("  ", err.message); failed++; },
        ),
      );
      return;
    }
    console.log("✓", name);
    passed++;
  } catch (err) {
    console.error("✗", name);
    console.error("  ", err.message);
    failed++;
  }
}

const scan = await import("../dist/rootScan.js");

// ---------- matchGlob ----------
test("matchGlob: literal exact", () => {
  assert.equal(scan.matchGlob("Daily.md", "Daily.md"), true);
  assert.equal(scan.matchGlob("Daily.md", "Other.md"), false);
});

test("matchGlob: * matches within a segment", () => {
  assert.equal(scan.matchGlob("*.excalidraw.md", "drawing.excalidraw.md"), true);
  assert.equal(scan.matchGlob("*.excalidraw.md", "drawing.md"), false);
});

test("matchGlob: segment-level wildcard", () => {
  assert.equal(scan.matchGlob("Daily/*", "Daily/2026-01-01.md"), true);
  assert.equal(scan.matchGlob("Daily/*", "Daily/sub/2026.md"), false);
  assert.equal(scan.matchGlob("Daily/*", "Other/2026-01-01.md"), false);
});

test("matchGlob: case insensitive", () => {
  assert.equal(scan.matchGlob("daily/*", "Daily/foo.md"), true);
});

// ---------- truncateBytes ----------
test("truncateBytes: short string returns unchanged", () => {
  const r = scan.truncateBytes("hello", 100);
  assert.equal(r.text, "hello");
  assert.equal(r.full_bytes, 5);
});

test("truncateBytes: ASCII truncates to exact byte count", () => {
  const r = scan.truncateBytes("hello world", 5);
  assert.equal(r.text, "hello");
  assert.equal(r.full_bytes, 11);
});

test("truncateBytes: never splits a multi-byte UTF-8 char", () => {
  // "中" is 3 bytes in UTF-8.
  const s = "abc中文";
  // 4 bytes would split "中" mid-character → should fall back to 3 bytes ("abc").
  const r = scan.truncateBytes(s, 4);
  assert.equal(r.text, "abc");
  assert.equal(r.full_bytes, Buffer.byteLength(s, "utf8"));
});

test("truncateBytes: maxBytes=0 returns empty string", () => {
  const r = scan.truncateBytes("anything", 0);
  assert.equal(r.text, "");
});

// ---------- parseFrontmatter ----------
test("parseFrontmatter: no frontmatter returns null fm + full body", () => {
  const r = scan.parseFrontmatter("# Hello\n\nbody");
  assert.equal(r.frontmatter, null);
  assert.equal(r.frontmatter_error, null);
  assert.equal(r.body, "# Hello\n\nbody");
});

test("parseFrontmatter: empty frontmatter block", () => {
  const r = scan.parseFrontmatter("---\n---\n# Body");
  assert.deepEqual(r.frontmatter, { tags: null, aliases: null, topic: null, _raw: "" });
  assert.equal(r.body, "# Body");
});

test("parseFrontmatter: inline array tags", () => {
  const md = "---\ntags: [webrtc, network]\ntopic: webrtc\n---\nbody";
  const r = scan.parseFrontmatter(md);
  assert.deepEqual(r.frontmatter.tags, ["webrtc", "network"]);
  assert.equal(r.frontmatter.topic, "webrtc");
  assert.equal(r.frontmatter.aliases, null);
  assert.equal(r.body, "body");
});

test("parseFrontmatter: block list tags", () => {
  const md = "---\ntags:\n  - a\n  - b\n---\nbody";
  const r = scan.parseFrontmatter(md);
  assert.deepEqual(r.frontmatter.tags, ["a", "b"]);
});

test("parseFrontmatter: single string tag becomes array", () => {
  const md = "---\ntags: solo\n---\nbody";
  const r = scan.parseFrontmatter(md);
  assert.deepEqual(r.frontmatter.tags, ["solo"]);
});

test("parseFrontmatter: aliases parsed same as tags", () => {
  const md = "---\naliases: [foo, bar]\n---\nbody";
  const r = scan.parseFrontmatter(md);
  assert.deepEqual(r.frontmatter.aliases, ["foo", "bar"]);
});

test("parseFrontmatter: malformed (no closing ---)", () => {
  const r = scan.parseFrontmatter("---\ntags: x\n# Body");
  assert.equal(r.frontmatter, null);
  assert.ok(r.frontmatter_error && r.frontmatter_error.length > 0);
  assert.equal(r.body, "---\ntags: x\n# Body");
});

test("parseFrontmatter: preserves raw block", () => {
  const md = "---\ntags: [x]\ncustom: keep me\n---\nbody";
  const r = scan.parseFrontmatter(md);
  assert.ok(r.frontmatter._raw.includes("custom: keep me"));
});

// ---------- parseFilesOutput ----------

test("parseFilesOutput: JSON array path", () => {
  const json = JSON.stringify([
    { path: "A.md", size: 1, mtime: "2026-05-01T00:00:00Z" },
    { path: "B.md", size: 2 },
  ]);
  const out = scan.parseFilesOutput(json);
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "A.md");
  assert.equal(out[1].size, 2);
});

test("parseFilesOutput: paths-format fallback for older CLI", () => {
  // Older Obsidian installers ignore `format=json` for the `files` command
  // and emit newline-separated paths instead. parseFilesOutput must accept
  // that shape and synthesize minimal entries.
  const txt = "Note A.md\n系統服務/db/db2 資料整理.md\nNote B.md\n";
  const out = scan.parseFilesOutput(txt);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((e) => e.path),
    ["Note A.md", "系統服務/db/db2 資料整理.md", "Note B.md"],
  );
  assert.equal(out[0].size, undefined);
});

test("parseFilesOutput: empty string returns empty array", () => {
  assert.deepEqual(scan.parseFilesOutput(""), []);
  assert.deepEqual(scan.parseFilesOutput("   \n"), []);
});

// ---------- scanRoot orchestration ----------

// Build a stub runner that returns canned responses keyed by command + params.
function makeRunner(responses) {
  return async (command, opts = {}) => {
    const key = command + ":" + JSON.stringify(opts.params ?? {});
    if (!(key in responses)) {
      throw new Error(`unstubbed call: ${key}`);
    }
    const r = responses[key];
    if (r instanceof Error) throw r;
    return { command: key, stdout: r, stderr: "", exitCode: 0 };
  };
}

test("scanRoot: works against paths-format CLI output (no size/mtime)", async () => {
  // Older Obsidian installer path: `files` returns plain paths.
  const pathsTxt = "Note A.md\nFolder/Sub.md\nNote B.md\n";
  const runner = makeRunner({
    'files:{}': pathsTxt,
    'read:{"path":"Note A.md"}': "# A\nbody",
    'read:{"path":"Note B.md"}': "# B\nbody",
  });
  const r = await scan.scanRoot({ runner });
  assert.equal(r.total_root_files, 2);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["Note A.md", "Note B.md"]);
  // No size/mtime in paths format — must default cleanly.
  assert.equal(r.files[0].size_bytes, 0);
  assert.equal(r.files[0].modified_at, "");
});

test("scanRoot: filters out subfolder entries", async () => {
  const filesJson = JSON.stringify([
    { path: "Note A.md", size: 100, mtime: "2026-05-01T00:00:00Z" },
    { path: "Folder/Sub.md", size: 50, mtime: "2026-05-01T00:00:00Z" },
    { path: "Note B.md", size: 200, mtime: "2026-05-02T00:00:00Z" },
  ]);
  const runner = makeRunner({
    'files:{}': filesJson,
    'read:{"path":"Note A.md"}': "# A\nbody",
    'read:{"path":"Note B.md"}': "# B\nbody",
  });
  const r = await scan.scanRoot({ runner });
  assert.equal(r.total_root_files, 2);
  assert.equal(r.files.length, 2);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["Note A.md", "Note B.md"]);
});

test("scanRoot: applies ignore globs", async () => {
  const filesJson = JSON.stringify([
    { path: "Note.md", size: 100, mtime: "2026-05-01T00:00:00Z" },
    { path: "drawing.excalidraw.md", size: 1000, mtime: "2026-05-01T00:00:00Z" },
  ]);
  const runner = makeRunner({
    'files:{}': filesJson,
    'read:{"path":"Note.md"}': "body",
  });
  const r = await scan.scanRoot({ runner, ignore: ["*.excalidraw.md"] });
  assert.equal(r.ignored_count, 1);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].path, "Note.md");
});

test("scanRoot: max_files truncates with flag", async () => {
  const filesJson = JSON.stringify([
    { path: "A.md", size: 1, mtime: "2026-05-01T00:00:00Z" },
    { path: "B.md", size: 1, mtime: "2026-05-01T00:00:00Z" },
    { path: "C.md", size: 1, mtime: "2026-05-01T00:00:00Z" },
  ]);
  const runner = makeRunner({
    'files:{}': filesJson,
    'read:{"path":"A.md"}': "a",
    'read:{"path":"B.md"}': "b",
  });
  const r = await scan.scanRoot({ runner, max_files: 2 });
  assert.equal(r.truncated, true);
  assert.equal(r.returned, 2);
  assert.equal(r.total_root_files, 3);
});

test("scanRoot: read failure isolates to one entry", async () => {
  const filesJson = JSON.stringify([
    { path: "Good.md", size: 1, mtime: "2026-05-01T00:00:00Z" },
    { path: "Bad.md", size: 1, mtime: "2026-05-01T00:00:00Z" },
  ]);
  const runner = makeRunner({
    'files:{}': filesJson,
    'read:{"path":"Good.md"}': "ok body",
    'read:{"path":"Bad.md"}': new Error("file locked"),
  });
  const r = await scan.scanRoot({ runner });
  const bad = r.files.find((f) => f.path === "Bad.md");
  const good = r.files.find((f) => f.path === "Good.md");
  assert.equal(bad.preview, null);
  assert.ok(bad.read_error.includes("file locked"));
  assert.equal(good.preview, "ok body");
  assert.equal(good.read_error, null);
});

test("scanRoot: preview is byte-truncated", async () => {
  const long = "a".repeat(2000);
  const filesJson = JSON.stringify([
    { path: "Long.md", size: 2000, mtime: "2026-05-01T00:00:00Z" },
  ]);
  const runner = makeRunner({
    'files:{}': filesJson,
    'read:{"path":"Long.md"}': long,
  });
  const r = await scan.scanRoot({ runner, preview_bytes: 100 });
  assert.equal(r.files[0].preview.length, 100);
  assert.equal(r.files[0].body_full_bytes, 2000);
});

test("scanRoot: extracts frontmatter into entry", async () => {
  const md = "---\ntags: [webrtc]\ntopic: webrtc\n---\nbody";
  const filesJson = JSON.stringify([
    { path: "Note.md", size: 100, mtime: "2026-05-01T00:00:00Z" },
  ]);
  const runner = makeRunner({
    'files:{}': filesJson,
    'read:{"path":"Note.md"}': md,
  });
  const r = await scan.scanRoot({ runner });
  assert.deepEqual(r.files[0].frontmatter.tags, ["webrtc"]);
  assert.equal(r.files[0].frontmatter.topic, "webrtc");
  assert.equal(r.files[0].preview, "body");
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
