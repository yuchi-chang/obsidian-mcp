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
    return {
      stdout: stripObsidianBanner(stdout),
      stderr,
      exitCode: 0,
      command: cmdline,
    };
  } catch (err: unknown) {
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
