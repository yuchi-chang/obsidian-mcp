#!/usr/bin/env node
// Unit tests for splitForCli — verify chunks reassemble exactly and respect
// the byte limit.
import assert from "node:assert/strict";
import { splitForCli, shouldChunk, getLimit } from "../dist/chunk.js";

const utf8 = (s) => Buffer.byteLength(s, "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("✓", name);
    passed++;
  } catch (err) {
    console.error("✗", name);
    console.error("  ", err.message);
    failed++;
  }
}

test("short content returns single chunk", () => {
  const c = "hello world";
  const out = splitForCli(c, 100);
  assert.deepEqual(out, [c]);
});

test("multi-line content splits at line boundaries", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: ` + "x".repeat(40));
  const c = lines.join("\n");
  const out = splitForCli(c, 500);
  // every chunk under limit
  for (const chunk of out) assert.ok(utf8(chunk) <= 500, `chunk size ${utf8(chunk)} > 500`);
  // perfect reassembly
  assert.equal(out.join(""), c);
  assert.ok(out.length > 1, "expected multiple chunks");
});

test("oversized single line falls back to character split", () => {
  const c = "x".repeat(2_000); // single line, no newlines
  const out = splitForCli(c, 300);
  for (const chunk of out) assert.ok(utf8(chunk) <= 300);
  assert.equal(out.join(""), c);
});

test("UTF-8 multi-byte characters are not split mid-codepoint", () => {
  // 中 = 3 bytes, repeated to overflow
  const c = "中".repeat(500);
  const out = splitForCli(c, 50);
  for (const chunk of out) {
    assert.ok(utf8(chunk) <= 50);
    // re-encode/decode round-trip should match — broken codepoints would corrupt.
    assert.equal(Buffer.from(chunk, "utf8").toString("utf8"), chunk);
  }
  assert.equal(out.join(""), c);
});

test("mixed content with very long line + many short lines", () => {
  const c =
    "short1\nshort2\n" + "y".repeat(5_000) + "\nshort3\n" + "short4";
  const out = splitForCli(c, 800);
  for (const chunk of out) assert.ok(utf8(chunk) <= 800);
  assert.equal(out.join(""), c);
});

test("shouldChunk reflects limit", () => {
  assert.equal(shouldChunk("x", 10), false);
  assert.equal(shouldChunk("x".repeat(100), 10), true);
});

test("default limit is positive", () => {
  assert.ok(getLimit() > 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
