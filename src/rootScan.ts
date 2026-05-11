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
