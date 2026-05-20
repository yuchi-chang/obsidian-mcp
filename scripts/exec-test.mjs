#!/usr/bin/env node
// Unit tests for exec.ts helpers — primarily the banner stripping that
// shields downstream code from older Obsidian installer noise.
import assert from "node:assert/strict";

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

const { stripObsidianBanner, parseJsonOrText, detectActionFailure } = await import(
  "../dist/exec.js"
);

test("stripObsidianBanner: passes through empty string", () => {
  assert.equal(stripObsidianBanner(""), "");
});

test("stripObsidianBanner: passes through clean stdout unchanged", () => {
  const s = "hello\nworld";
  assert.equal(stripObsidianBanner(s), s);
});

test("stripObsidianBanner: strips leading CR/LF then both banner lines", () => {
  const banner =
    "\r\n2026-05-11 03:38:10 Loading updated app package C:\\path\\to\\obsidian.asar\r\n" +
    "Your Obsidian installer is out of date. Please download the latest installer\r\n";
  const payload = "real content line 1\nreal content line 2";
  assert.equal(stripObsidianBanner(banner + payload), payload);
});

test("stripObsidianBanner: strips banner with LF-only line endings", () => {
  const s =
    "2026-05-11 03:38:10 Loading updated app package /tmp/x.asar\n" +
    "Your Obsidian installer is out of date.\n" +
    "[]";
  assert.equal(stripObsidianBanner(s), "[]");
});

test("stripObsidianBanner: strips banner when only loading line present", () => {
  const s =
    "2026-05-11 03:38:10 Loading updated app package /tmp/x.asar\n[1,2,3]";
  assert.equal(stripObsidianBanner(s), "[1,2,3]");
});

test("stripObsidianBanner: leaves non-banner first line alone", () => {
  // A real note's body may start with what looks like a date but not the
  // banner suffix — it must NOT be stripped.
  const s = "2026-05-11 my journal entry\nmore text";
  assert.equal(stripObsidianBanner(s), s);
});

test("stripObsidianBanner: handles banner-only stdout (no payload)", () => {
  const s =
    "\r\n2026-05-11 03:38:10 Loading updated app package /tmp/x.asar\r\n" +
    "Your Obsidian installer is out of date.\r\n";
  assert.equal(stripObsidianBanner(s), "");
});

test("parseJsonOrText: returns trimmed text for non-JSON input", () => {
  assert.equal(parseJsonOrText("  hello\n"), "hello");
});

test("parseJsonOrText: parses JSON when present", () => {
  assert.deepEqual(parseJsonOrText("[1,2,3]"), [1, 2, 3]);
});

test("parseJsonOrText: returns null on empty/whitespace input", () => {
  assert.equal(parseJsonOrText("   \n"), null);
});

// detectActionFailure: the Obsidian CLI prints "Error: ..." to stdout and
// still exits 0 when an action command (move/delete/...) fails. These tests
// pin down the detection that turns those silent failures into thrown
// ObsidianCliError instances inside runObsidian.

test("detectActionFailure: flags Error stdout on action command (move)", () => {
  const stdout =
    "Error: ENOENT: no such file or directory, rename 'a.md' -> 'New/a.md'";
  assert.equal(detectActionFailure("move", stdout), stdout);
});

test("detectActionFailure: flags Error stdout on delete", () => {
  assert.equal(
    detectActionFailure("delete", 'Error: File "Missing.md" not found.'),
    'Error: File "Missing.md" not found.',
  );
});

test("detectActionFailure: ignores success stdout on action command", () => {
  assert.equal(detectActionFailure("move", "Moved: a.md -> b/a.md"), null);
});

test("detectActionFailure: trims surrounding whitespace before checking prefix", () => {
  // stripObsidianBanner may leave a leading newline; the detector must still
  // recognise the error.
  const stdout = "\n  Error: ENOENT: missing folder\n";
  assert.equal(detectActionFailure("create", stdout), "Error: ENOENT: missing folder");
});

test("detectActionFailure: does NOT flag content commands (read)", () => {
  // A note's body that legitimately begins with "Error:" must not be
  // misinterpreted as a CLI failure.
  const stdout = "Error: handling guide\n\nThis note documents...";
  assert.equal(detectActionFailure("read", stdout), null);
});

test("detectActionFailure: does NOT flag eval (arbitrary user script output)", () => {
  assert.equal(detectActionFailure("eval", "Error: something the script printed"), null);
});

test("detectActionFailure: ignores empty stdout", () => {
  assert.equal(detectActionFailure("move", ""), null);
});

test("detectActionFailure: requires 'Error: ' prefix exactly (case-sensitive)", () => {
  // Note bodies like "error: lowercase" or "ERROR" should not trigger.
  assert.equal(detectActionFailure("move", "error: lowercase"), null);
  assert.equal(detectActionFailure("move", "ERROR: SHOUTING"), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
