import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ParamValue = string | number | boolean | undefined | null;

export interface RunOptions {
  vault?: string;
  params?: Record<string, ParamValue>;
  flags?: string[];
  format?: "json" | "csv" | "tsv" | "md" | "paths" | "yaml" | "tree";
  copy?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}

export class ObsidianCliError extends Error {
  constructor(
    message: string,
    public readonly result: RunResult,
  ) {
    super(message);
    this.name = "ObsidianCliError";
  }
}

function buildArgs(command: string, opts: RunOptions): string[] {
  const args: string[] = [];
  if (opts.vault) args.push(`vault=${opts.vault}`);
  // command can be hierarchical like "property:set" or "daily:append"
  args.push(command);
  if (opts.params) {
    for (const [key, value] of Object.entries(opts.params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "boolean") {
        if (value) args.push(key); // boolean flag style
        continue;
      }
      args.push(`${key}=${String(value)}`);
    }
  }
  if (opts.flags) args.push(...opts.flags);
  if (opts.format) args.push(`format=${opts.format}`);
  if (opts.copy) args.push("--copy");
  return args;
}

// Action commands return short status text ("Moved: X -> Y", "Deleted: X",
// etc.). On failure the CLI prints "Error: <message>" to stdout but still
// exits 0 — see detectActionFailure below. Content-returning commands
// (read/search/eval/...) are deliberately excluded because their stdout may
// legitimately begin with the literal text "Error:" and we don't want to
// false-positive on note content.
export const ACTION_COMMANDS: ReadonlySet<string> = new Set([
  "move",
  "delete",
  "create",
  "append",
  "prepend",
  "property:set",
  "property:remove",
  "tags:rename",
  "daily:append",
  "plugin:enable",
  "plugin:disable",
  "plugin:reload",
]);

// Returns the trimmed error message when an action command's stdout indicates
// failure, or null otherwise. Exported so unit tests can exercise the
// detection without spawning a real CLI.
export function detectActionFailure(command: string, cleanStdout: string): string | null {
  if (!ACTION_COMMANDS.has(command)) return null;
  if (!/^Error: /.test(cleanStdout.trimStart())) return null;
  return cleanStdout.trim();
}

export async function runObsidian(
  command: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const bin = process.env.OBSIDIAN_CLI ?? "obsidian";
  const args = buildArgs(command, opts);
  // Diagnostic only — execFile passes `args` as argv, never as a shell string.
  // This avoids cmd.exe's ~8191-char limit AND its truncation of LF-bearing
  // arguments (which corrupted multi-line content like frontmatter blocks).
  const cmdline = [bin, ...args].join(" ");

  try {
    const { stdout, stderr } = await execFile(bin, args, {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const cleanStdout = stripObsidianBanner(stdout);
    // The Obsidian CLI prints "Error: ..." to stdout AND exits 0 when an
    // action command (move/delete/create/...) fails. Without this check the
    // failure surfaces as a silent success — moves report "applied" while
    // files stay put. Throw so callers see the same shape they'd get from a
    // proper non-zero exit.
    const actionFailure = detectActionFailure(command, cleanStdout);
    if (actionFailure !== null) {
      const result: RunResult = {
        stdout: cleanStdout,
        stderr,
        exitCode: 0,
        command: cmdline,
      };
      throw new ObsidianCliError(
        `obsidian ${command} reported failure: ${actionFailure}`,
        result,
      );
    }
    return {
      stdout: cleanStdout,
      stderr,
      exitCode: 0,
      command: cmdline,
    };
  } catch (err: unknown) {
    if (err instanceof ObsidianCliError) throw err;
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const result: RunResult = {
      stdout: stripObsidianBanner(e.stdout ?? ""),
      stderr: e.stderr ?? e.message ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
      command: cmdline,
    };
    if (e.code === "ENOENT") {
      throw new ObsidianCliError(
        `Obsidian CLI binary not found ('${bin}'). ` +
          `Make sure Obsidian is running and the CLI is registered ` +
          `(Settings → General → Command line interface → Register CLI). ` +
          `Override with the OBSIDIAN_CLI env var if the binary lives elsewhere.`,
        result,
      );
    }
    throw new ObsidianCliError(
      `obsidian CLI exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      result,
    );
  }
}

// Older Obsidian installers (<= 1.12.x at time of writing) emit two banner
// lines to stdout on every CLI invocation:
//
//   <timestamp> Loading updated app package <path>
//   Your Obsidian installer is out of date. Please download...
//
// These poison machine-readable output (JSON.parse on `files`, frontmatter
// detection on `read`, etc.). Strip them at the runObsidian boundary so all
// downstream code sees only the real payload.
//
// Patterns are anchored to the literal banner text — too specific to collide
// with note content. Only consecutive matching lines at the start are dropped.
const BANNER_PATTERNS: RegExp[] = [
  /^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} Loading updated app package\b.*$/,
  /^\s*Your Obsidian installer is out of date\b.*$/,
];

export function stripObsidianBanner(stdout: string): string {
  if (!stdout) return stdout;
  // Strip any leading CR/LF before the first banner line.
  let s = stdout.replace(/^(?:\r?\n)+/, "");
  // Repeatedly peel the first line if it matches a banner pattern.
  while (true) {
    const nl = s.search(/\r?\n/);
    const firstLine = nl === -1 ? s : s.slice(0, nl);
    if (!BANNER_PATTERNS.some((re) => re.test(firstLine))) break;
    if (nl === -1) return "";
    s = s.slice(nl + (s[nl] === "\r" ? 2 : 1));
  }
  return s;
}

export function parseJsonOrText(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
