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

export type ValidationResult =
  | {
      ok: true;
      items: ValidatedItem[];
      summary: PlanSummary;
      new_folders: string[];
    }
  | {
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
