# Organize Root Notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two MCP tools — `obsidian_scan_root` (read root-level notes with metadata + preview) and `obsidian_organize_apply` (validate + dry-run + confirmed batch move with topic registration) — so a caller LLM can classify and reorganize loose root notes in one batch.

**Architecture:** Two new modules — `src/rootScan.ts` (read-only scan) and `src/organize.ts` (write: validate, dry-run, apply). Both expose pure helpers + an orchestration function with a `runner` DI seam so tests can stub `runObsidian`. Tool handlers in `src/tools.ts` are thin wrappers that translate input/output. Topic-store registration reuses `recordUse` from `topicStore.ts`.

**Tech Stack:** Node ≥18, TypeScript, MCP SDK, zod, plain `node:assert/strict` test scripts in `scripts/*.mjs` that import compiled `dist/*.js`.

**Workflow note:** This project compiles TS to `dist/` before testing. Every test step assumes `npm run build` has run. Each task includes the build step before running its test.

**Spec reference:** `docs/superpowers/specs/2026-05-08-organize-root-notes-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/rootScan.ts` | Create | Pure helpers (glob match, byte truncate, frontmatter parse) + `scanRoot()` orchestration |
| `src/organize.ts` | Create | Pure helpers (`normalizeFolder`, `validatePlan`) + `applyPlan()` orchestration + `ensureFolders()` if needed |
| `src/tools.ts` | Modify | Register `obsidian_scan_root` + `obsidian_organize_apply` tool defs |
| `scripts/root-scan-test.mjs` | Create | Unit tests for rootScan helpers + orchestration with stubbed runner |
| `scripts/organize-test.mjs` | Create | Unit tests for organize validate + apply with stubbed runner + recordUse |
| `scripts/organize-smoke.mjs` | Create | Manual smoke test against a real vault — answers the "does CLI move auto-create folders" question |
| `package.json` | Modify | Add new test scripts to `npm test` chain |
| `README.md` | Modify | Add "Bulk organize root notes" section |

---

## Task 1: Glob matcher helper in rootScan.ts

**Files:**
- Create: `src/rootScan.ts` (skeleton + `matchGlob` only)
- Create: `scripts/root-scan-test.mjs` (skeleton + glob tests only)

Goal: a minimal glob matcher that handles `*` (any chars within a path segment, no `/`) and literal segments. No `**` — YAGNI for the root-only scope. Patterns and paths are compared after lowercasing both — vault folders on Windows are case-insensitive in practice.

- [ ] **Step 1: Write the failing test**

Create `scripts/root-scan-test.mjs`:

```javascript
#!/usr/bin/env node
// Unit tests for rootScan helpers + orchestration.
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { console.log("✓", name); passed++; },
        (err) => { console.error("✗", name); console.error("  ", err.message); failed++; },
      );
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build && node scripts/root-scan-test.mjs
```

Expected: build succeeds (no rootScan.ts yet → tsc fails) — that IS the failure signal. If build passes but `await import("../dist/rootScan.js")` errors with "module not found", that's also the expected failure.

- [ ] **Step 3: Implement matchGlob**

Create `src/rootScan.ts`:

```typescript
// Vault-root scanner. Lists root-level .md files with metadata + preview so a
// caller LLM can classify each one for bulk organization.

/**
 * Match a vault-relative path against a simple glob.
 *
 * Supports:
 *   - literal segments
 *   - `*` matching any chars within a single segment (no `/`)
 *
 * Does NOT support `**` — YAGNI for root-only scanning. Comparison is
 * case-insensitive (matches Windows vault behavior).
 */
export function matchGlob(pattern: string, path: string): boolean {
  const pSegs = pattern.toLowerCase().split("/");
  const tSegs = path.toLowerCase().split("/");
  if (pSegs.length !== tSegs.length) return false;
  for (let i = 0; i < pSegs.length; i++) {
    if (!segmentMatch(pSegs[i], tSegs[i])) return false;
  }
  return true;
}

function segmentMatch(pat: string, seg: string): boolean {
  // Convert glob segment to regex: escape regex chars, then * → .*
  const re = pat
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${re}$`).test(seg);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npm run build && node scripts/root-scan-test.mjs
```

Expected: `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```
git add src/rootScan.ts scripts/root-scan-test.mjs
git commit -m "feat: add matchGlob helper for root scanner"
```

---

## Task 2: UTF-8 byte truncation helper

**Files:**
- Modify: `src/rootScan.ts` — add `truncateBytes`
- Modify: `scripts/root-scan-test.mjs` — add tests

Goal: `truncateBytes(text, maxBytes)` returns `{ text, full_bytes }` where `text` is truncated to at most `maxBytes` UTF-8 bytes, never splitting a multi-byte char.

- [ ] **Step 1: Write the failing test**

Append to `scripts/root-scan-test.mjs` (before the `console.log` summary):

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
npm run build && node scripts/root-scan-test.mjs
```

Expected: TypeScript build fails because `truncateBytes` is not exported.

- [ ] **Step 3: Implement truncateBytes**

Append to `src/rootScan.ts`:

```typescript
/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, never splitting a
 * multi-byte character. Returns the truncated text plus the original byte
 * count (so callers can tell whether truncation happened).
 */
export function truncateBytes(
  text: string,
  maxBytes: number,
): { text: string; full_bytes: number } {
  const buf = Buffer.from(text, "utf8");
  const full_bytes = buf.length;
  if (full_bytes <= maxBytes) return { text, full_bytes };
  if (maxBytes <= 0) return { text: "", full_bytes };

  // Walk back from maxBytes until we land on a UTF-8 boundary. Continuation
  // bytes start with bits 10xxxxxx (0x80..0xBF).
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.slice(0, end).toString("utf8"), full_bytes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npm run build && node scripts/root-scan-test.mjs
```

Expected: `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```
git add src/rootScan.ts scripts/root-scan-test.mjs
git commit -m "feat: add UTF-8 safe truncateBytes helper"
```

---

## Task 3: Frontmatter parser

**Files:**
- Modify: `src/rootScan.ts` — add `parseFrontmatter`
- Modify: `scripts/root-scan-test.mjs` — add tests

Goal: extract the YAML frontmatter block delimited by `---` and return both the raw block and a best-effort shallow parse of three keys: `tags`, `aliases`, `topic`.

The parser handles three common YAML shapes for those keys:
- `tags: [a, b, c]` — inline array
- `tags:\n  - a\n  - b` — block list
- `tags: foo` — single string (returned as `["foo"]` for arrays, raw string for `topic`)

If frontmatter is malformed (no closing `---`), returns `frontmatter: null` + `frontmatter_error` populated; body is the entire input.

- [ ] **Step 1: Write the failing test**

Append to `scripts/root-scan-test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
npm run build && node scripts/root-scan-test.mjs
```

Expected: build fails — `parseFrontmatter` not exported.

- [ ] **Step 3: Implement parseFrontmatter**

Append to `src/rootScan.ts`:

```typescript
export interface ParsedFrontmatter {
  tags: string[] | null;
  aliases: string[] | null;
  topic: string | null;
  _raw: string;
}

export interface ParseResult {
  frontmatter: ParsedFrontmatter | null;
  frontmatter_error: string | null;
  body: string;
}

/**
 * Best-effort frontmatter extraction. Pulls `tags`, `aliases`, `topic`
 * via simple line-based parsing — handles inline arrays, block lists, and
 * scalar strings. The raw YAML is preserved on `_raw` for fidelity.
 *
 * If no frontmatter is present, returns `frontmatter: null` and the body
 * is the input unchanged. If a `---` opener exists but no closer is found,
 * treats the entire input as body and reports the error.
 */
export function parseFrontmatter(md: string): ParseResult {
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) {
    return { frontmatter: null, frontmatter_error: null, body: md };
  }
  // Find closing fence.
  const lines = md.split(/\r?\n/);
  // lines[0] === "---"
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { endIdx = i; break; }
  }
  if (endIdx === -1) {
    return {
      frontmatter: null,
      frontmatter_error: "Frontmatter has no closing '---'",
      body: md,
    };
  }
  const rawLines = lines.slice(1, endIdx);
  const raw = rawLines.join("\n");
  const fm: ParsedFrontmatter = {
    tags: extractListOrString(rawLines, "tags"),
    aliases: extractListOrString(rawLines, "aliases"),
    topic: extractScalar(rawLines, "topic"),
    _raw: raw,
  };
  const body = lines.slice(endIdx + 1).join("\n").replace(/^\n+/, "");
  return { frontmatter: fm, frontmatter_error: null, body };
}

function extractListOrString(lines: string[], key: string): string[] | null {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest === "") {
      // Block list expected on subsequent indented lines.
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s+-\s+(.+?)\s*$/);
        if (!item) break;
        items.push(stripQuotes(item[1]));
      }
      return items.length > 0 ? items : null;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      if (inner === "") return [];
      return inner.split(",").map((s) => stripQuotes(s.trim())).filter((s) => s.length > 0);
    }
    // Scalar — wrap in array for tags/aliases.
    return [stripQuotes(rest)];
  }
  return null;
}

function extractScalar(lines: string[], key: string): string | null {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`);
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      const v = m[1].trim();
      return v === "" ? null : stripQuotes(v);
    }
  }
  return null;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npm run build && node scripts/root-scan-test.mjs
```

Expected: `16 passed, 0 failed`.

- [ ] **Step 5: Commit**

```
git add src/rootScan.ts scripts/root-scan-test.mjs
git commit -m "feat: add best-effort frontmatter parser"
```

---

## Task 4: scanRoot orchestration

**Files:**
- Modify: `src/rootScan.ts` — add `scanRoot()` and types
- Modify: `scripts/root-scan-test.mjs` — add orchestration tests with stubbed runner

Goal: the main `scanRoot()` function. Lists root, applies ignore globs, reads each file, builds preview entries. Takes a `runner` parameter for DI.

- [ ] **Step 1: Write the failing test**

Append to `scripts/root-scan-test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
npm run build && node scripts/root-scan-test.mjs
```

Expected: build fails — `scanRoot` not exported.

- [ ] **Step 3: Implement scanRoot**

Append to `src/rootScan.ts`:

```typescript
import type { runObsidian } from "./exec.js";
type Runner = typeof runObsidian;

export interface RootFile {
  path: string;
  size_bytes: number;
  modified_at: string;
  frontmatter: ParsedFrontmatter | null;
  frontmatter_error: string | null;
  preview: string | null;
  body_full_bytes: number;
  read_error: string | null;
}

export interface ScanRootResult {
  scanned_at: string;
  total_root_files: number;
  returned: number;
  truncated: boolean;
  ignored_count: number;
  files: RootFile[];
}

export interface ScanRootOptions {
  vault?: string;
  ignore?: string[];
  preview_bytes?: number;
  max_files?: number;
  /** Concurrency limit for `read` calls. Default 5. */
  concurrency?: number;
  /** DI seam for tests. Defaults to the real `runObsidian`. */
  runner?: Runner;
}

interface FilesEntry {
  path: string;
  size?: number;
  mtime?: string;
}

export async function scanRoot(opts: ScanRootOptions = {}): Promise<ScanRootResult> {
  const {
    vault,
    ignore = [],
    preview_bytes = 800,
    max_files = 200,
    concurrency = 5,
  } = opts;
  const runner = opts.runner ?? (await import("./exec.js")).runObsidian;

  const listRes = await runner("files", { vault, format: "json" });
  let entries: FilesEntry[];
  try {
    const parsed = JSON.parse(listRes.stdout);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(
      `Failed to parse files JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Root level only: path with no '/' and ending in .md
  const rootMd = entries.filter(
    (e) => typeof e.path === "string" && !e.path.includes("/") && e.path.toLowerCase().endsWith(".md"),
  );

  // Apply ignore globs.
  const kept: FilesEntry[] = [];
  let ignored = 0;
  for (const e of rootMd) {
    if (ignore.some((g) => matchGlob(g, e.path))) {
      ignored++;
    } else {
      kept.push(e);
    }
  }

  const total = kept.length;
  const truncated = total > max_files;
  const slice = truncated ? kept.slice(0, max_files) : kept;

  // Bounded concurrency.
  const files: RootFile[] = await mapConcurrent(slice, concurrency, async (e) => {
    let raw: string | null = null;
    let read_error: string | null = null;
    try {
      const r = await runner("read", { vault, params: { path: e.path } });
      raw = r.stdout;
    } catch (err) {
      read_error = err instanceof Error ? err.message : String(err);
    }
    if (raw === null) {
      return {
        path: e.path,
        size_bytes: e.size ?? 0,
        modified_at: e.mtime ?? "",
        frontmatter: null,
        frontmatter_error: null,
        preview: null,
        body_full_bytes: 0,
        read_error,
      };
    }
    const { frontmatter, frontmatter_error, body } = parseFrontmatter(raw);
    const trunc = truncateBytes(body, preview_bytes);
    return {
      path: e.path,
      size_bytes: e.size ?? 0,
      modified_at: e.mtime ?? "",
      frontmatter,
      frontmatter_error,
      preview: trunc.text,
      body_full_bytes: trunc.full_bytes,
      read_error: null,
    };
  });

  return {
    scanned_at: new Date().toISOString(),
    total_root_files: total,
    returned: files.length,
    truncated,
    ignored_count: ignored,
    files,
  };
}

async function mapConcurrent<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npm run build && node scripts/root-scan-test.mjs
```

Expected: `22 passed, 0 failed`.

- [ ] **Step 5: Commit**

```
git add src/rootScan.ts scripts/root-scan-test.mjs
git commit -m "feat: add scanRoot orchestration with concurrency-limited reads"
```

---

## Task 5: organize.ts plan validation

**Files:**
- Create: `src/organize.ts` — types + `normalizeFolder` + `validatePlan`
- Create: `scripts/organize-test.mjs` — test scaffolding + validation tests

Goal: pure validation that takes a plan + the vault's existing folder list and returns a normalized plan with per-entry status pre-assigned.

- [ ] **Step 1: Write the failing test**

Create `scripts/organize-test.mjs`:

```javascript
#!/usr/bin/env node
// Unit tests for organize plan validation + apply.
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { console.log("✓", name); passed++; },
        (err) => { console.error("✗", name); console.error("  ", err.message); failed++; },
      );
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run tests to verify they fail**

```
npm run build && node scripts/organize-test.mjs
```

Expected: build fails — `organize.ts` does not exist.

- [ ] **Step 3: Implement validatePlan**

Create `src/organize.ts`:

```typescript
// Validate, dry-run, and apply a root-organize plan.

export type ItemStatus = "ok" | "conflict" | "noop" | "failed";

export interface PlanEntry {
  path: string;
  target_folder: string;
  topic?: string;
  reason?: string;
}

export interface ValidatedItem {
  path: string;
  target_folder: string;       // normalized
  topic: string | null;
  reason: string | null;
  to: string;                  // computed destination path
  is_new_folder: boolean;
  status: ItemStatus;
  error: string | null;
}

export interface PlanSummary {
  total: number;
  will_move: number;
  will_create_folders: number;
  noop: number;
  conflict: number;
  applied: number;
  failed: number;
}

export interface ValidationResult {
  ok: true;
  items: ValidatedItem[];
  summary: PlanSummary;
  new_folders: string[];
} | {
  ok: false;
  error: string;
};

/** Strip leading/trailing slashes; treat ""/"/"/"." as vault root. */
export function normalizeFolder(folder: string): string {
  const cleaned = folder.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  if (cleaned === "" || cleaned === ".") return "";
  return cleaned;
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

export function validatePlan(args: {
  plan: PlanEntry[];
  existingFolders: string[];     // vault-relative, no leading/trailing slash
  existingFiles: string[];       // vault-relative .md paths
}): ValidationResult {
  const { plan, existingFolders, existingFiles } = args;

  // Plan-level checks first.
  const seen = new Set<string>();
  for (const e of plan) {
    if (seen.has(e.path)) {
      return { ok: false, error: `Duplicate path in plan: ${e.path}` };
    }
    seen.add(e.path);
  }

  const folderSet = new Set(existingFolders.map((f) => f.toLowerCase()));
  const fileSet = new Set(existingFiles.map((f) => f.toLowerCase()));

  const items: ValidatedItem[] = [];
  for (const entry of plan) {
    if (entry.path.includes("/")) {
      return { ok: false, error: `Plan entry path must be at root level (no '/'): ${entry.path}` };
    }
    if (!entry.path.toLowerCase().endsWith(".md")) {
      return { ok: false, error: `Plan entry path must end in .md: ${entry.path}` };
    }
    const folder = normalizeFolder(entry.target_folder);
    if (folder.split(/[\\/]+/).some((seg) => seg === "..")) {
      return { ok: false, error: `target_folder must not contain '..': ${entry.target_folder}` };
    }

    const to = joinPath(folder, basename(entry.path));
    const is_new_folder = folder !== "" && !folderSet.has(folder.toLowerCase());

    let status: ItemStatus = "ok";
    let error: string | null = null;

    if (folder === "" && !entry.path.includes("/")) {
      status = "noop";
    } else if (to.toLowerCase() !== entry.path.toLowerCase() && fileSet.has(to.toLowerCase())) {
      status = "conflict";
      error = "Destination already exists";
    }

    items.push({
      path: entry.path,
      target_folder: folder,
      topic: entry.topic ?? null,
      reason: entry.reason ?? null,
      to,
      is_new_folder,
      status,
      error,
    });
  }

  const newFolders = Array.from(
    new Set(items.filter((i) => i.is_new_folder && i.status === "ok").map((i) => i.target_folder)),
  );
  const summary: PlanSummary = {
    total: items.length,
    will_move: items.filter((i) => i.status === "ok").length,
    will_create_folders: newFolders.length,
    noop: items.filter((i) => i.status === "noop").length,
    conflict: items.filter((i) => i.status === "conflict").length,
    applied: 0,
    failed: 0,
  };

  return { ok: true, items, summary, new_folders: newFolders };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npm run build && node scripts/organize-test.mjs
```

Expected: `11 passed, 0 failed`.

- [ ] **Step 5: Commit**

```
git add src/organize.ts scripts/organize-test.mjs
git commit -m "feat: add organize plan validation"
```

---

## Task 6: organize.ts applyPlan with stubbed runner + recordUse

**Files:**
- Modify: `src/organize.ts` — add `applyPlan` orchestration
- Modify: `scripts/organize-test.mjs` — add apply tests

Goal: take a `ValidationResult`, run moves for `ok` items, register topics on success. DI for `runner` and a `topicRecorder` stub.

- [ ] **Step 1: Write the failing test**

Append to `scripts/organize-test.mjs` (before the summary console.log):

```javascript
// ---------- applyPlan ----------

function makeRunner(responses) {
  const calls = [];
  const runner = async (command, opts = {}) => {
    calls.push({ command, opts });
    const key = command + ":" + JSON.stringify(opts.params ?? {});
    if (!(key in responses)) {
      throw new Error(`unstubbed call: ${key}`);
    }
    const r = responses[key];
    if (r instanceof Error) throw r;
    return { command: key, stdout: r, stderr: "", exitCode: 0 };
  };
  runner.calls = calls;
  return runner;
}

test("applyPlan: dry_run does no moves and no topic record", async () => {
  const validated = org.validatePlan({
    plan: [{ path: "A.md", target_folder: "webrtc", topic: "webrtc" }],
    existingFolders: [],
    existingFiles: ["A.md"],
  });
  assert.equal(validated.ok, true);
  const runner = makeRunner({});
  const recorded = [];
  const r = await org.applyPlan({
    validated,
    dry_run: true,
    runner,
    topicRecorder: (topic, folder) => recorded.push({ topic, folder }),
  });
  assert.equal(runner.calls.length, 0);
  assert.equal(recorded.length, 0);
  assert.equal(r.summary.applied, 0);
  assert.equal(r.summary.failed, 0);
  assert.equal(r.dry_run, true);
});

test("applyPlan: apply happy path moves + records topic", async () => {
  const validated = org.validatePlan({
    plan: [{ path: "A.md", target_folder: "webrtc", topic: "webrtc" }],
    existingFolders: [],
    existingFiles: ["A.md"],
  });
  const runner = makeRunner({
    'move:{"path":"A.md","to":"webrtc/A.md"}': "ok",
  });
  const recorded = [];
  const r = await org.applyPlan({
    validated,
    dry_run: false,
    runner,
    topicRecorder: (topic, folder) => recorded.push({ topic, folder }),
  });
  assert.equal(r.summary.applied, 1);
  assert.equal(r.summary.failed, 0);
  assert.deepEqual(recorded, [{ topic: "webrtc", folder: "webrtc" }]);
  assert.equal(r.items[0].status, "ok");
});

test("applyPlan: failed move marks item, skips topic record", async () => {
  const validated = org.validatePlan({
    plan: [
      { path: "A.md", target_folder: "good", topic: "good" },
      { path: "B.md", target_folder: "bad", topic: "bad" },
    ],
    existingFolders: [],
    existingFiles: ["A.md", "B.md"],
  });
  const runner = makeRunner({
    'move:{"path":"A.md","to":"good/A.md"}': "ok",
    'move:{"path":"B.md","to":"bad/B.md"}': new Error("disk full"),
  });
  const recorded = [];
  const r = await org.applyPlan({
    validated,
    dry_run: false,
    runner,
    topicRecorder: (topic, folder) => recorded.push({ topic, folder }),
  });
  assert.equal(r.summary.applied, 1);
  assert.equal(r.summary.failed, 1);
  assert.deepEqual(recorded, [{ topic: "good", folder: "good" }]);
  const bItem = r.items.find((i) => i.path === "B.md");
  assert.equal(bItem.status, "failed");
  assert.match(bItem.error, /disk full/);
});

test("applyPlan: register_topics=false skips recordUse", async () => {
  const validated = org.validatePlan({
    plan: [{ path: "A.md", target_folder: "webrtc", topic: "webrtc" }],
    existingFolders: [],
    existingFiles: ["A.md"],
  });
  const runner = makeRunner({
    'move:{"path":"A.md","to":"webrtc/A.md"}': "ok",
  });
  const recorded = [];
  const r = await org.applyPlan({
    validated,
    dry_run: false,
    register_topics: false,
    runner,
    topicRecorder: (topic, folder) => recorded.push({ topic, folder }),
  });
  assert.equal(r.summary.applied, 1);
  assert.deepEqual(recorded, []);
});

test("applyPlan: skips conflict and noop items", async () => {
  const validated = org.validatePlan({
    plan: [
      { path: "A.md", target_folder: "" },              // noop
      { path: "B.md", target_folder: "Notes" },         // conflict
      { path: "C.md", target_folder: "Inbox" },         // ok (existing folder)
    ],
    existingFolders: ["Notes", "Inbox"],
    existingFiles: ["A.md", "B.md", "C.md", "Notes/B.md"],
  });
  const runner = makeRunner({
    'move:{"path":"C.md","to":"Inbox/C.md"}': "ok",
  });
  const r = await org.applyPlan({
    validated,
    dry_run: false,
    runner,
    topicRecorder: () => {},
  });
  assert.equal(r.summary.applied, 1);
  assert.equal(r.summary.noop, 1);
  assert.equal(r.summary.conflict, 1);
  assert.equal(runner.calls.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npm run build && node scripts/organize-test.mjs
```

Expected: build fails — `applyPlan` not exported.

- [ ] **Step 3: Implement applyPlan**

Append to `src/organize.ts`:

```typescript
import type { runObsidian } from "./exec.js";
type Runner = typeof runObsidian;

export type TopicRecorder = (topic: string, folder: string) => void;

export interface ApplyResult {
  dry_run: boolean;
  summary: PlanSummary;
  new_folders: string[];
  items: ValidatedItem[];
  warnings: string[];
}

export interface ApplyOptions {
  validated: Extract<ValidationResult, { ok: true }>;
  dry_run: boolean;
  register_topics?: boolean;
  vault?: string;
  runner: Runner;
  topicRecorder: TopicRecorder;
}

export async function applyPlan(opts: ApplyOptions): Promise<ApplyResult> {
  const { validated, dry_run, register_topics = true, vault, runner, topicRecorder } = opts;
  const items = validated.items.map((i) => ({ ...i }));
  const warnings: string[] = [];
  let applied = 0;
  let failed = 0;

  if (!dry_run) {
    for (const item of items) {
      if (item.status !== "ok") continue;
      try {
        await runner("move", { vault, params: { path: item.path, to: item.to } });
        applied++;
        if (register_topics && item.topic) {
          try {
            topicRecorder(item.topic, item.target_folder);
          } catch (err) {
            warnings.push(
              `recordUse failed for topic="${item.topic}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        item.status = "failed";
        item.error = err instanceof Error ? err.message : String(err);
        failed++;
      }
    }
  }

  return {
    dry_run,
    summary: { ...validated.summary, applied, failed },
    new_folders: validated.new_folders,
    items,
    warnings,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npm run build && node scripts/organize-test.mjs
```

Expected: `16 passed, 0 failed`.

- [ ] **Step 5: Commit**

```
git add src/organize.ts scripts/organize-test.mjs
git commit -m "feat: add applyPlan with topic recording"
```

---

## Task 7: Wire `obsidian_scan_root` into tools.ts

**Files:**
- Modify: `src/tools.ts` — add tool definition

Goal: register the scan tool. Reuses `runObsidian` from `exec.ts` as the runner — no DI in production.

- [ ] **Step 1: Add the import + tool definition**

In `src/tools.ts`, add to the imports near the top (find the existing `import { findSimilarFolders, ... } from "./folderSearch.js";` line and add the new import beside it):

```typescript
import { scanRoot } from "./rootScan.js";
```

Then in the `tools` array, add this entry near the other read-only tools (after `obsidian_list_folders`, around line 538):

```typescript
  {
    name: "obsidian_scan_root",
    title: "Scan vault root for loose notes",
    description:
      "Lists every .md file at the vault root with frontmatter and a body preview. " +
      "Use this as the first step of bulk-organize: feed the result to a classifier " +
      "(LLM) that decides per-note where each should go, then call " +
      "`obsidian_organize_apply` with the resulting plan.\n\n" +
      "Files inside subfolders are NOT included. `ignore` accepts simple globs " +
      "(e.g. ['Daily/*', '*.excalidraw.md']) matched against vault-relative paths.",
    inputSchema: {
      ...VaultArg,
      ignore: z
        .array(z.string())
        .optional()
        .describe(
          "Glob patterns to exclude (matched against vault-relative paths). " +
            "Supports `*` within a segment; no `**`.",
        ),
      preview_bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Bytes of body preview to return per file. Default 800."),
      max_files: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap on returned entries. Default 200."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, ignore, preview_bytes, max_files }) => {
      try {
        const result = await scanRoot({ vault, ignore, preview_bytes, max_files });
        return textResult(JSON.stringify(result, null, 2), result as unknown as Record<string, unknown>);
      } catch (err) {
        return errorResult(err);
      }
    },
  },
```

- [ ] **Step 2: Build to verify the new tool compiles**

```
npm run build
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: Verify existing tests still pass**

```
npm test
```

Expected: every existing test script passes.

- [ ] **Step 4: Commit**

```
git add src/tools.ts
git commit -m "feat: register obsidian_scan_root tool"
```

---

## Task 8: Wire `obsidian_organize_apply` into tools.ts

**Files:**
- Modify: `src/tools.ts` — add tool definition with ConfirmSpec

Goal: register the apply tool. The handler does these things:
1. Run `listVaultFolders()` and `obsidian files` to gather `existingFolders` + `existingFiles` for validation.
2. Call `validatePlan()`.
3. Call `applyPlan()` with real `runner` and `recordUse` as `topicRecorder`.
4. Wrap output as `textResult`.

`recordUse` requires a `vaultKey` — use `vault ?? "_default"` to mirror the existing pattern in `obsidian_create_note`.

- [ ] **Step 1: Add imports**

In `src/tools.ts`, near the top imports add:

```typescript
import { applyPlan, validatePlan } from "./organize.js";
import { listVaultFolders } from "./folderSearch.js";
```

(`findSimilarFolders` is already imported from `folderSearch.js`. Just append `listVaultFolders` to the same import line.)

- [ ] **Step 2: Add the tool definition**

In the `tools` array, add this entry (place it after `obsidian_scan_root`, keeping organize tools grouped):

```typescript
  {
    name: "obsidian_organize_apply",
    title: "Apply a root-organize plan",
    description:
      "Validates a routing plan and (if `dry_run=false`) moves the listed root notes " +
      "into their target folders. Folders that don't exist are created during the move. " +
      "When an entry has a `topic`, the topic→folder mapping is recorded in the persistent " +
      "topic store after a successful move (set `register_topics=false` to opt out).\n\n" +
      "ALWAYS dry-run first: call with `dry_run=true` to see the predicted outcome, " +
      "then re-call with `dry_run=false` once the plan looks right. The output shape is " +
      "identical between modes.\n\n" +
      "Per-entry failure isolation: a single move failure marks that entry `status: \"failed\"` " +
      "but does not stop the rest of the batch.",
    inputSchema: {
      ...VaultArg,
      plan: z
        .array(
          z.object({
            path: z
              .string()
              .min(1)
              .describe("Vault-relative path of a root-level .md file."),
            target_folder: z
              .string()
              .describe(
                "Vault-relative target folder. Empty string, '/', or '.' means keep at root.",
              ),
            topic: z
              .string()
              .optional()
              .describe(
                "Optional topic facet. Recorded in the persistent topic store on successful move.",
              ),
            reason: z
              .string()
              .optional()
              .describe("Optional free-text rationale, ignored by the tool but echoed back."),
          }),
        )
        .min(1)
        .describe("Routing plan — one entry per root note to move."),
      dry_run: z
        .boolean()
        .describe(
          "Required. When true, validates and returns the predicted outcome WITHOUT moving any files. " +
            "When false, performs the moves after the standard confirmation prompt.",
        ),
      register_topics: z
        .boolean()
        .optional()
        .describe(
          "When true (default), records topic→folder mappings in the topic store after successful moves.",
        ),
      ...ConfirmArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    confirm: {
      action: ({ plan }: { plan: Array<{ target_folder: string }> }) =>
        `Reorganize ${plan.length} root note${plan.length === 1 ? "" : "s"}`,
      detail: ({ plan }: { plan: Array<{ target_folder: string }> }) => {
        const folders = new Set(
          plan.map((p) => p.target_folder.replace(/^[\\/]+|[\\/]+$/g, "")).filter((f) => f),
        );
        return `${plan.length} note(s) → ${folders.size} folder(s)`;
      },
    },
    handler: async ({ vault, plan, dry_run, register_topics }) => {
      try {
        const [existingFolders, filesRes] = await Promise.all([
          listVaultFolders(vault),
          runObsidian("files", { vault, format: "json" }),
        ]);
        const filesParsed = parseJsonOrText(filesRes.stdout);
        const existingFiles: string[] = Array.isArray(filesParsed)
          ? filesParsed
              .map((e: unknown) =>
                e && typeof e === "object" && "path" in e ? String((e as { path: unknown }).path) : "",
              )
              .filter((p: string) => p.length > 0)
          : [];

        const validated = validatePlan({ plan, existingFolders, existingFiles });
        if (!validated.ok) {
          return errorResult(new Error(validated.error));
        }

        const vaultKey = vault ?? "_default";
        const result = await applyPlan({
          validated,
          dry_run,
          register_topics,
          vault,
          runner: runObsidian,
          topicRecorder: (topic, folder) => {
            recordUse(vaultKey, topic, folder);
          },
        });
        return textResult(JSON.stringify(result, null, 2), result as unknown as Record<string, unknown>);
      } catch (err) {
        return errorResult(err);
      }
    },
  },
```

This handler uses `runObsidian`, `parseJsonOrText`, and `recordUse` — all already imported at the top of `tools.ts`.

- [ ] **Step 3: Build and run all existing tests**

```
npm run build && npm test
```

Expected: build succeeds, all existing tests pass.

- [ ] **Step 4: Add the new test scripts to `npm test`**

Modify `package.json`. Find the `test` script line:

```json
"test": "node scripts/chunk-test.mjs && node scripts/topic-store-test.mjs && node scripts/smoke-test.mjs && node scripts/confirm-test.mjs && node scripts/routing-test.mjs",
```

Replace with:

```json
"test": "node scripts/chunk-test.mjs && node scripts/topic-store-test.mjs && node scripts/smoke-test.mjs && node scripts/confirm-test.mjs && node scripts/routing-test.mjs && node scripts/root-scan-test.mjs && node scripts/organize-test.mjs",
```

- [ ] **Step 5: Run full test suite**

```
npm run build && npm test
```

Expected: every test script passes.

- [ ] **Step 6: Commit**

```
git add src/tools.ts package.json
git commit -m "feat: register obsidian_organize_apply tool"
```

---

## Task 9: Smoke test — verify CLI move folder behavior

**Files:**
- Create: `scripts/organize-smoke.mjs` — manual dev smoke test

Goal: answer the open spec question "does `obsidian move` auto-create intermediate folders?" Without this answer, the `apply` step might silently fail when target_folder doesn't exist. This script is **not** added to `npm test` — it requires a real running Obsidian.

- [ ] **Step 1: Create the smoke script**

Create `scripts/organize-smoke.mjs`:

```javascript
#!/usr/bin/env node
// Manual smoke test for organize_apply.
//
// Requires:
//   - A running Obsidian instance with the CLI registered
//   - A test vault you don't mind writing to (set OBSIDIAN_TEST_VAULT env var)
//
// What it tests:
//   1. CLI `move` to a NEW folder — does it auto-create the folder?
//   2. End-to-end scan → validate → apply on three throwaway notes.
//
// Usage:
//   OBSIDIAN_TEST_VAULT="MyTestVault" node scripts/organize-smoke.mjs

import assert from "node:assert/strict";

const VAULT = process.env.OBSIDIAN_TEST_VAULT;
if (!VAULT) {
  console.error("Set OBSIDIAN_TEST_VAULT to the name of a test vault.");
  process.exit(2);
}

const exec = await import("../dist/exec.js");
const scan = await import("../dist/rootScan.js");
const org = await import("../dist/organize.js");
const search = await import("../dist/folderSearch.js");

const stamp = Date.now();
const probeName = `organize-smoke-${stamp}.md`;
const probeFolder = `organize-smoke-folder-${stamp}`;

console.log(`Vault: ${VAULT}`);
console.log(`Probe note: ${probeName}`);
console.log(`Probe folder: ${probeFolder}\n`);

async function run() {
  // 1. Create probe note at root.
  await exec.runObsidian("create", {
    vault: VAULT,
    params: { name: probeName, content: `# probe ${stamp}` },
  });
  console.log(`✓ created ${probeName}`);

  // 2. Try to move it into a non-existent folder.
  let moveCreatesFolder = false;
  try {
    await exec.runObsidian("move", {
      vault: VAULT,
      params: { path: probeName, to: `${probeFolder}/${probeName}` },
    });
    moveCreatesFolder = true;
    console.log(`✓ move succeeded — CLI auto-creates intermediate folders`);
  } catch (err) {
    console.log(`✗ move failed without pre-created folder: ${err.message}`);
  }

  // 3. Verify final location.
  const folders = await search.listVaultFolders(VAULT);
  const folderExists = folders.some((f) => f === probeFolder);
  console.log(`Folder now exists in vault: ${folderExists}`);

  // 4. Cleanup — delete the probe note.
  const cleanupPath = moveCreatesFolder ? `${probeFolder}/${probeName}` : probeName;
  try {
    await exec.runObsidian("delete", { vault: VAULT, params: { path: cleanupPath } });
    console.log(`✓ cleaned up ${cleanupPath}`);
  } catch (err) {
    console.log(`! cleanup failed (please delete manually): ${err.message}`);
  }

  // 5. Final report.
  console.log(`\nResult: CLI move ${moveCreatesFolder ? "DOES" : "DOES NOT"} auto-create folders.`);
  if (!moveCreatesFolder) {
    console.log(
      "→ Implement ensureFolders() in organize.ts to create destination folders before move.",
    );
  }
}

run().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the smoke test against your dev vault**

Set `OBSIDIAN_TEST_VAULT` to a test vault name (open Obsidian with that vault first):

```
npm run build
$env:OBSIDIAN_TEST_VAULT="YourTestVaultName"
node scripts/organize-smoke.mjs
```

Expected output: one of two outcomes:
- "CLI move DOES auto-create folders" → no further work needed for Task 10.
- "CLI move DOES NOT auto-create folders" → proceed with Task 10 (`ensureFolders` fallback).

Record the result in the next step's commit message.

- [ ] **Step 3: Commit the smoke test**

```
git add scripts/organize-smoke.mjs
git commit -m "test: add manual smoke test for CLI move folder behavior"
```

---

## Task 10: ensureFolders fallback (only if Task 9 showed move does NOT auto-create)

**Skip this task if the smoke test showed `move` auto-creates folders.** In that case, proceed to Task 11.

**Files:**
- Modify: `src/organize.ts` — add `ensureFolders` and call it from `applyPlan`
- Modify: `scripts/organize-test.mjs` — add tests

Goal: create new folders by writing a placeholder note then deleting it. Done once before the move loop, only for the unique `new_folders` set.

- [ ] **Step 1: Write the failing test**

Append to `scripts/organize-test.mjs`:

```javascript
test("applyPlan: ensures new folders by create+delete placeholder", async () => {
  const validated = org.validatePlan({
    plan: [{ path: "A.md", target_folder: "newdir", topic: "x" }],
    existingFolders: [],
    existingFiles: ["A.md"],
  });
  const runner = makeRunner({
    'create:{"path":"newdir/.organize-placeholder.md","content":""}': "ok",
    'delete:{"path":"newdir/.organize-placeholder.md"}': "ok",
    'move:{"path":"A.md","to":"newdir/A.md"}': "ok",
  });
  const r = await org.applyPlan({
    validated,
    dry_run: false,
    runner,
    topicRecorder: () => {},
  });
  assert.equal(r.summary.applied, 1);
  // Verify ordering: create-placeholder → delete-placeholder → move
  const order = runner.calls.map((c) => c.command);
  assert.deepEqual(order, ["create", "delete", "move"]);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run build && node scripts/organize-test.mjs
```

Expected: the new test fails because `applyPlan` doesn't pre-create folders.

- [ ] **Step 3: Implement ensureFolders + call it**

In `src/organize.ts`, before the `applyPlan` function, add:

```typescript
async function ensureFolders(
  folders: string[],
  vault: string | undefined,
  runner: Runner,
): Promise<void> {
  for (const folder of folders) {
    const placeholder = `${folder}/.organize-placeholder.md`;
    await runner("create", { vault, params: { path: placeholder, content: "" } });
    await runner("delete", { vault, params: { path: placeholder } });
  }
}
```

Then in `applyPlan`, before the move loop (still inside `if (!dry_run)`), add:

```typescript
    if (validated.new_folders.length > 0) {
      try {
        await ensureFolders(validated.new_folders, vault, runner);
      } catch (err) {
        warnings.push(
          `ensureFolders failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```
npm run build && node scripts/organize-test.mjs
```

Expected: all organize tests pass (17 total now).

- [ ] **Step 5: Commit**

```
git add src/organize.ts scripts/organize-test.mjs
git commit -m "feat: add ensureFolders fallback for new directories"
```

---

## Task 11: README documentation

**Files:**
- Modify: `README.md`

Goal: add a "Bulk organize root notes" section that shows the three-step caller flow.

- [ ] **Step 1: Add the section to README.md**

Find the existing "Topic-aware routing" section in `README.md`. After it, add this new section (insert before the next major heading):

```markdown
## Bulk organize root notes

When the vault root accumulates loose `.md` files, the caller LLM can sweep them into the right subfolders in three steps:

1. **Scan** — list root notes with metadata + body preview:

   ```jsonc
   // tool: obsidian_scan_root
   { "ignore": ["Daily/*", "*.excalidraw.md"] }
   ```

2. **Classify (caller side)** — the LLM reads each preview and proposes a routing plan:

   ```jsonc
   [
     { "path": "WebRTC 連線建立流程.md", "target_folder": "webrtc", "topic": "webrtc", "reason": "covers signaling/SDP/ICE" },
     { "path": "舊筆記.md", "target_folder": "Notes", "topic": "misc" }
   ]
   ```

3. **Apply** — dry-run first to preview, then call again with `dry_run: false`:

   ```jsonc
   // tool: obsidian_organize_apply
   { "plan": [...], "dry_run": true }
   // → { "summary": { "will_move": 2, "will_create_folders": 1, ... }, "items": [...] }

   { "plan": [...], "dry_run": false, "confirm": true }
   // → moves files, creates new folders as needed, registers topic→folder mappings
   ```

Per-entry failure isolation: a single move failure marks that entry `status: "failed"` without aborting the rest of the batch. Successful moves with a `topic` field are recorded in the persistent topic store, so future single-note writes for that topic auto-route.
```

- [ ] **Step 2: Commit**

```
git add README.md
git commit -m "doc: add Bulk organize root notes section"
```

---

## Self-Review

Performed the four checks from the writing-plans skill against this plan and the spec:

**1. Spec coverage:**
- `obsidian_scan_root` → Tasks 1–4, 7
- `obsidian_organize_apply` → Tasks 5, 6, 8
- Topic store side effect (`recordUse` after success) → Task 6, 8
- ConfirmArg + ConfirmSpec → Task 8 (uses existing pattern)
- ensureFolders fallback → Task 10 (conditional on Task 9 result)
- Tests for every behaviour listed in spec § 5 → Tasks 4, 5, 6, 10
- README docs → Task 11

**2. Placeholder scan:** No "TBD"/"TODO"/"similar to Task N" — every step has full code or exact commands.

**3. Type consistency:** `ValidatedItem`, `PlanEntry`, `ApplyResult`, `ApplyOptions` are defined in Task 5/6 and used consistently in Task 8. The `runner` parameter shape (`typeof runObsidian`) matches across `scanRoot`, `applyPlan`, `ensureFolders`. `topicRecorder` signature is consistent (Task 6 + Task 8 handler). Result field names match the spec output examples exactly: `summary.will_move`, `summary.will_create_folders`, `items[].is_new_folder`, etc.

**4. Ambiguity:** `target_folder === ""` is normalized in `normalizeFolder` and treated as "keep at root" consistently. `noop` only triggers when the source is already at root AND target normalizes to root — this is what Task 5's test case explicitly locks in.
