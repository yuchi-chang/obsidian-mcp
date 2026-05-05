import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCallback);

const SAFE_ARG = /^[A-Za-z0-9=_\-./:\\@]+$/;

function shellQuote(arg: string): string {
  if (SAFE_ARG.test(arg)) return arg;
  if (process.platform === "win32") {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

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
  const cmdline = [bin, ...args].map(shellQuote).join(" ");

  try {
    const { stdout, stderr } = await exec(cmdline, {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr, exitCode: 0, command: cmdline };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const result: RunResult = {
      stdout: e.stdout ?? "",
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

export function parseJsonOrText(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
