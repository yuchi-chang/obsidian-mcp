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
  const patternSegs = pattern.toLowerCase().split("/");
  const pathSegs = path.toLowerCase().split("/");
  if (patternSegs.length !== pathSegs.length) return false;
  for (let i = 0; i < patternSegs.length; i++) {
    if (!segmentMatch(patternSegs[i], pathSegs[i])) return false;
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

// Newer Obsidian installers honor `format=json` for the `files` command and
// return `[{path, size, mtime}, ...]`. Older installers ignore the format flag
// and just print newline-separated vault-relative paths. Support both so the
// scanner keeps working across CLI versions.
export function parseFilesOutput(stdout: string): FilesEntry[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  }
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((path) => ({ path }));
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
  const entries = parseFilesOutput(listRes.stdout);

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
