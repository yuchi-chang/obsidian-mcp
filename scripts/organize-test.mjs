#!/usr/bin/env node
// Unit tests for organize plan validation + apply.
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

const org = await import("../dist/organize.js");

// ---------- normalizeFolder ----------
test("normalizeFolder: empty/slash/dot all become ''", () => {
  assert.equal(org.normalizeFolder(""), "");
  assert.equal(org.normalizeFolder("/"), "");
  assert.equal(org.normalizeFolder("."), "");
});

test("normalizeFolder: strips leading/trailing slashes", () => {
  assert.equal(org.normalizeFolder("/Notes/"), "Notes");
  assert.equal(org.normalizeFolder("Notes/Sub/"), "Notes/Sub");
});

// ---------- validatePlan ----------
test("validatePlan: rejects path containing '/'", () => {
  const r = org.validatePlan({
    plan: [{ path: "Sub/Note.md", target_folder: "Other" }],
    existingFolders: [],
    existingFiles: ["Sub/Note.md"],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /root level/i);
});

test("validatePlan: rejects target_folder with '..'", () => {
  const r = org.validatePlan({
    plan: [{ path: "Note.md", target_folder: "../escape" }],
    existingFolders: [],
    existingFiles: ["Note.md"],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /\.\./);
});

test("validatePlan: rejects duplicate paths", () => {
  const r = org.validatePlan({
    plan: [
      { path: "Note.md", target_folder: "A" },
      { path: "Note.md", target_folder: "B" },
    ],
    existingFolders: [],
    existingFiles: ["Note.md"],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /duplicate/i);
});

test("validatePlan: marks noop for empty target on root file", () => {
  const r = org.validatePlan({
    plan: [{ path: "Note.md", target_folder: "" }],
    existingFolders: [],
    existingFiles: ["Note.md"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].status, "noop");
});

test("validatePlan: marks conflict when destination exists", () => {
  const r = org.validatePlan({
    plan: [{ path: "Note.md", target_folder: "Notes" }],
    existingFolders: ["Notes"],
    existingFiles: ["Note.md", "Notes/Note.md"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].status, "conflict");
});

test("validatePlan: marks is_new_folder when target absent", () => {
  const r = org.validatePlan({
    plan: [{ path: "Note.md", target_folder: "webrtc" }],
    existingFolders: [],
    existingFiles: ["Note.md"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].is_new_folder, true);
  assert.equal(r.items[0].status, "ok");
});

test("validatePlan: existing folder → not new", () => {
  const r = org.validatePlan({
    plan: [{ path: "Note.md", target_folder: "Notes" }],
    existingFolders: ["Notes"],
    existingFiles: ["Note.md"],
  });
  assert.equal(r.items[0].is_new_folder, false);
});

test("validatePlan: computes summary correctly", () => {
  const r = org.validatePlan({
    plan: [
      { path: "A.md", target_folder: "webrtc" },     // ok, new folder
      { path: "B.md", target_folder: "Notes" },      // conflict
      { path: "C.md", target_folder: "" },           // noop
      { path: "D.md", target_folder: "Notes" },      // ok, existing
    ],
    existingFolders: ["Notes"],
    existingFiles: ["A.md", "B.md", "C.md", "D.md", "Notes/B.md"],
  });
  assert.equal(r.summary.total, 4);
  assert.equal(r.summary.will_move, 2);
  assert.equal(r.summary.noop, 1);
  assert.equal(r.summary.conflict, 1);
  assert.equal(r.summary.will_create_folders, 1);
  assert.deepEqual(r.new_folders, ["webrtc"]);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
