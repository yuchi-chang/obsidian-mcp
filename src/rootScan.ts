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
