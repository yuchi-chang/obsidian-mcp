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

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
