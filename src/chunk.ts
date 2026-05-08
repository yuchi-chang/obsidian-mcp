// Splits long content strings into chunks small enough to pass via the
// platform's command-line argument limit. The Obsidian CLI does not yet
// support stdin or @file syntax for `content=`, so the value must travel
// on argv. We invoke the CLI via execFile (CreateProcess directly on
// Windows, no cmd.exe), so the limit is the OS argv cap — ~32767 chars
// on Windows, ARG_MAX on POSIX (typically 128KB+). Leave headroom for
// the other args (vault, command, path, format, …) and quoting.

const DEFAULT_LIMIT_BYTES =
  process.platform === "win32" ? 24_000 : 100_000;

function configuredLimit(): number {
  const env = process.env.OBSIDIAN_MCP_MAX_ARG_BYTES;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_LIMIT_BYTES;
}

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Splits content into UTF-8-safe chunks, each at or below `maxBytes`. Prefers
 * line boundaries; falls back to character boundaries for very long single
 * lines. The concatenation of all chunks is byte-identical to the input.
 */
export function splitForCli(content: string, maxBytes?: number): string[] {
  const limit = maxBytes ?? configuredLimit();
  if (utf8(content) <= limit) return [content];

  const chunks: string[] = [];
  // Split keeping newline delimiters so we can reassemble losslessly.
  const parts = content.split(/(\n)/);
  let current = "";

  const flush = () => {
    if (current.length) {
      chunks.push(current);
      current = "";
    }
  };

  for (const part of parts) {
    if (utf8(current) + utf8(part) <= limit) {
      current += part;
      continue;
    }
    // current + part overflows. Flush current first.
    flush();

    if (utf8(part) <= limit) {
      current = part;
      continue;
    }

    // Single part is itself oversized — hard-split by characters
    // (codepoint-safe since we iterate by JS string units; we re-check bytes
    // at every character boundary).
    let acc = "";
    for (const ch of part) {
      const next = acc + ch;
      if (utf8(next) > limit) {
        chunks.push(acc);
        acc = ch;
      } else {
        acc = next;
      }
    }
    current = acc;
  }

  flush();
  return chunks;
}

export function shouldChunk(content: string, maxBytes?: number): boolean {
  return utf8(content) > (maxBytes ?? configuredLimit());
}

export function getLimit(): number {
  return configuredLimit();
}
