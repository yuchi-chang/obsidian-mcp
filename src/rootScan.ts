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
