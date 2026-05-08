#!/usr/bin/env node
// Unit tests for the persistent topic store + similarity search.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect store root to a temp dir so tests don't pollute ~/.obsidian-mcp.
const tmpHome = mkdtempSync(join(tmpdir(), "obsidian-mcp-test-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

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

const store = await import("../dist/topicStore.js");
const search = await import("../dist/folderSearch.js");

test("loadStore returns empty store on first read", () => {
  const s = store.loadStore("vaultA");
  assert.equal(s.version, 1);
  assert.deepEqual(s.topics, {});
});

test("recordUse creates entry, increments uses, persists", () => {
  const e1 = store.recordUse("vaultA", "recipe-chinese", "食譜/中式");
  assert.equal(e1.uses, 1);
  assert.equal(e1.folder, "食譜/中式");
  const e2 = store.recordUse("vaultA", "recipe-chinese", "食譜/中式");
  assert.equal(e2.uses, 2);
  store._clearCache();
  const reloaded = store.loadStore("vaultA");
  assert.equal(reloaded.topics["recipe-chinese"].uses, 2);
});

test("recordUse updates folder when same topic remapped", () => {
  store.recordUse("vaultA", "topicX", "Old/Folder");
  const updated = store.recordUse("vaultA", "topicX", "New/Folder");
  assert.equal(updated.folder, "New/Folder");
  assert.equal(updated.uses, 2);
});

test("removeTopic deletes the entry", () => {
  store.recordUse("vaultA", "tmp", "X");
  assert.equal(store.removeTopic("vaultA", "tmp"), true);
  assert.equal(store.removeTopic("vaultA", "tmp"), false);
});

test("getStats sorts by usage desc", () => {
  store._clearCache();
  rmSyncSafe(store.storePath("vaultB"));
  store.recordUse("vaultB", "low", "L");
  store.recordUse("vaultB", "high", "H");
  store.recordUse("vaultB", "high", "H");
  store.recordUse("vaultB", "high", "H");
  const stats = store.getStats("vaultB");
  assert.equal(stats.totalTopics, 2);
  assert.equal(stats.totalWrites, 4);
  assert.equal(stats.topics[0].topic, "high");
  assert.equal(stats.topics[0].uses, 3);
});

test("vaultKey is sanitized in store path", () => {
  const p = store.storePath("../escape/me");
  assert.ok(!p.includes(".."), `path leaked .. : ${p}`);
});

test("similarity: identical tokens score 1", () => {
  const { score } = search.scoreSimilarity("recipe", "recipe");
  assert.equal(score, 1);
});

test("similarity: 'recipe-chinese' matches '食譜/中式' weakly via CJK fallback or zero", () => {
  // ASCII tokenizer can't tokenize CJK; this asserts only that we don't crash.
  const r = search.scoreSimilarity("recipe-chinese", "食譜/中式");
  assert.ok(r.score >= 0 && r.score <= 1);
});

test("similarity: 'recipe-chinese' scores against 'Recipes/Chinese'", () => {
  const { score, matchedTokens } = search.scoreSimilarity(
    "recipe-chinese",
    "Recipes/Chinese",
  );
  assert.ok(score > 0.4, `expected > 0.4, got ${score}`);
  assert.ok(matchedTokens.includes("chinese"));
});

test("similarity: unrelated returns 0", () => {
  const { score } = search.scoreSimilarity("meeting", "Recipes/Chinese");
  assert.equal(score, 0);
});

test("tokenize handles slashes, dashes, underscores", () => {
  assert.deepEqual(search.tokenize("Foo-Bar/Baz_Qux"), ["foo", "bar", "baz", "qux"]);
});

function rmSyncSafe(p) {
  try {
    if (existsSync(p)) rmSync(p);
  } catch {}
}

// Cleanup
process.on("exit", () => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
