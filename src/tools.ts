import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLimit, shouldChunk, splitForCli } from "./chunk.js";
import { ObsidianCliError, parseJsonOrText, runObsidian } from "./exec.js";
import { findSimilarFolders, listVaultFolders, type FolderMatch } from "./folderSearch.js";
import { scanRoot } from "./rootScan.js";
import { applyPlan, validatePlan } from "./organize.js";
import {
  getStats,
  loadStore,
  recordUse,
  removeTopic as removeTopicEntry,
} from "./topicStore.js";

export interface ToolContext {
  server: McpServer;
}

// ---------- shared schema fragments ----------

const VaultArg = {
  vault: z
    .string()
    .optional()
    .describe(
      "Vault name to target. Optional — defaults to the most recently focused vault.",
    ),
};

const FileTargetArg = {
  file: z
    .string()
    .optional()
    .describe(
      "Note name resolved as a wikilink (e.g. 'My Note'). Provide either `file` or `path`.",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Vault-root-relative path to the note (e.g. 'Folder/My Note.md'). Provide either `file` or `path`.",
    ),
};

function requireFileTarget(input: { file?: string; path?: string }) {
  if (!input.file && !input.path) {
    throw new Error(
      "Either `file` (wikilink name) or `path` (vault-relative path) must be provided.",
    );
  }
}

// ---------- result helpers ----------

interface McpToolContent {
  type: "text";
  text: string;
}

interface McpToolResult {
  [key: string]: unknown;
  content: McpToolContent[];
  structuredContent?: { [key: string]: unknown };
  isError?: boolean;
}

function textResult(text: string, structured?: unknown): McpToolResult {
  const isObject =
    structured !== null &&
    typeof structured === "object";
  return {
    content: [{ type: "text", text }],
    ...(isObject
      ? {
          structuredContent: Array.isArray(structured)
            ? { items: structured }
            : (structured as { [key: string]: unknown }),
        }
      : {}),
  };
}

function errorResult(err: unknown): McpToolResult {
  const message =
    err instanceof ObsidianCliError
      ? `${err.message}\n\nCommand: ${err.result.command}`
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function runJson(
  command: string,
  opts: Parameters<typeof runObsidian>[1] = {},
): Promise<McpToolResult> {
  try {
    const result = await runObsidian(command, { ...opts, format: opts.format ?? "json" });
    const parsed = parseJsonOrText(result.stdout);
    const text =
      typeof parsed === "string"
        ? parsed
        : JSON.stringify(parsed, null, 2);
    return textResult(text || "(no output)", parsed);
  } catch (err) {
    return errorResult(err);
  }
}

async function runText(
  command: string,
  opts: Parameters<typeof runObsidian>[1] = {},
): Promise<McpToolResult> {
  try {
    const result = await runObsidian(command, opts);
    const text = result.stdout.trim() || result.stderr.trim() || "(no output)";
    return textResult(text);
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * Writes content to a note in chunks when it would overflow the platform's
 * command-line argument limit. Subsequent chunks are appended after the
 * initial write so the on-disk content is byte-identical to a single write.
 *
 * `firstCommand` runs with the first chunk (e.g. `create` or `append`).
 * `appendCommand` runs for chunks 2..N and must accept `file=`/`path=` so we
 * can re-target the just-written note.
 */
async function runChunkedWrite(args: {
  content: string;
  firstCommand: string;
  firstParams: Record<string, string | undefined>;
  appendTarget: { file?: string; path?: string };
  vault?: string;
}): Promise<McpToolResult> {
  const { content, firstCommand, firstParams, appendTarget, vault } = args;
  const chunks = splitForCli(content);

  if (chunks.length === 1) {
    // Fast path — fits in one call.
    return runText(firstCommand, {
      vault,
      params: { ...firstParams, content: chunks[0] },
    });
  }

  const summary: string[] = [
    `Content was ${Buffer.byteLength(content, "utf8")} bytes ` +
      `(over the ${getLimit()}-byte argv limit on this platform); ` +
      `wrote in ${chunks.length} chunks.`,
  ];

  // First chunk uses the requested command (create or append).
  try {
    const first = await runObsidian(firstCommand, {
      vault,
      params: { ...firstParams, content: chunks[0] },
    });
    summary.push(`  chunk 1/${chunks.length}: ok`);
    if (first.stderr.trim()) summary.push(`    stderr: ${first.stderr.trim()}`);
  } catch (err) {
    return errorResult(
      err instanceof Error
        ? new Error(
            `Failed on chunk 1/${chunks.length}; note state unchanged.\n${err.message}`,
          )
        : err,
    );
  }

  // Remaining chunks always go through `append` against the new note.
  for (let i = 1; i < chunks.length; i++) {
    try {
      await runObsidian("append", {
        vault,
        params: { ...appendTarget, content: chunks[i] },
      });
      summary.push(`  chunk ${i + 1}/${chunks.length}: ok`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.push(`  chunk ${i + 1}/${chunks.length}: FAILED — ${msg}`);
      summary.push(
        `Note is in a partially-written state; chunks 1..${i} were written.`,
      );
      return {
        content: [{ type: "text", text: summary.join("\n") }],
        isError: true,
      };
    }
  }

  return textResult(summary.join("\n"));
}

function joinVaultPath(folder: string, name: string): string {
  const f = folder.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  return f ? `${f}/${name}` : name;
}

interface RouteResult {
  ok: boolean;
  path: string;
  reason: string;
  trail: string[];
}

/**
 * Resolves a topic to a folder: stored map → similarity scan → user
 * elicitation → record. Falls back to topic-as-folder if elicitation isn't
 * available.
 */
async function routeForTopic(args: {
  ctx: ToolContext;
  topic: string;
  name: string;
  vault?: string;
  vaultKey: string;
  preDecidedFolder?: string;
}): Promise<RouteResult> {
  const { ctx, topic, name, vault, vaultKey, preDecidedFolder } = args;
  const trail: string[] = [];

  // 1. Pre-decided folder (agent already obtained user approval upstream).
  if (preDecidedFolder) {
    const entry = recordUse(vaultKey, topic, preDecidedFolder);
    trail.push(
      `[routed] topic="${topic}" → ${entry.folder} (recorded; ${entry.uses} use${entry.uses === 1 ? "" : "s"})`,
    );
    return { ok: true, path: joinVaultPath(entry.folder, name), reason: "pre-decided", trail };
  }

  // 2. Hit in persistent store.
  const store = loadStore(vaultKey);
  const known = store.topics[topic];
  if (known) {
    const entry = recordUse(vaultKey, topic, known.folder);
    trail.push(
      `[routed] topic="${topic}" → ${entry.folder} (stored route; ${entry.uses} use${entry.uses === 1 ? "" : "s"})`,
    );
    return { ok: true, path: joinVaultPath(entry.folder, name), reason: "stored", trail };
  }

  // 3. Unknown topic — scan vault for similar folders.
  let suggestions: FolderMatch[] = [];
  try {
    suggestions = await findSimilarFolders({ topic, vault, threshold: 0.25, limit: 5 });
  } catch (err) {
    trail.push(
      `[warn] could not scan vault folders: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 4. Try to ask the user via elicitation.
  //
  // Two-stage flow when we have suggestions:
  //   Stage 1 — enum single-select: existing matches + topic-default + "Vault root" + "Other...".
  //             Lets the user accept a preselected default in one click instead of forcing them
  //             to type into a blank textbox (the previous schema had no default/enum, so clients
  //             rejected an empty submission and bounced the user back to typing).
  //   Stage 2 — only if user picks "Other...": free-text input with the topic-default prefilled.
  // When there are no suggestions we skip stage 1 and go straight to stage 2.
  const caps = ctx.server.server.getClientCapabilities();
  if (caps?.elicitation) {
    const OTHER = "__other__";
    const ROOT = "__root__";
    const defaultFolder = defaultFolderForTopic(topic);

    let chosenFolder: string | null = null;
    let elicitationFailed = false;

    if (suggestions.length > 0) {
      const values: string[] = [];
      const labels: string[] = [];
      for (const s of suggestions) {
        values.push(s.folder);
        labels.push(`${s.folder}  (similarity ${s.score.toFixed(2)})`);
      }
      if (!suggestions.some((s) => s.folder === defaultFolder)) {
        values.push(defaultFolder);
        labels.push(`${defaultFolder}  (new — based on topic)`);
      }
      values.push(ROOT);
      labels.push("Vault root (no folder)");
      values.push(OTHER);
      labels.push("Other... (type a custom folder)");

      try {
        const pick = await ctx.server.server.elicitInput({
          message: `Topic "${topic}" is new in vault "${vaultKey}". Where should these notes live?`,
          requestedSchema: {
            type: "object",
            properties: {
              choice: {
                type: "string",
                title: "Folder",
                description: `Vault-relative folder for topic "${topic}".`,
                enum: values,
                enumNames: labels,
                default: values[0],
              },
            },
            required: ["choice"],
          },
        });

        if (pick.action !== "accept") {
          return {
            ok: false,
            path: "",
            reason: `User ${pick.action}ed the folder prompt.`,
            trail,
          };
        }

        const choice = String(pick.content?.choice ?? "").trim();
        if (choice === ROOT) {
          chosenFolder = "";
        } else if (choice && choice !== OTHER) {
          chosenFolder = choice;
        }
        // choice === OTHER → fall through to stage 2
      } catch (err) {
        trail.push(
          `[warn] elicitation (stage 1) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        elicitationFailed = true;
      }
    }

    if (chosenFolder === null && !elicitationFailed) {
      const stage2Message =
        suggestions.length > 0
          ? `Type a vault-relative folder path for topic "${topic}". Use "/" for vault root.`
          : `Topic "${topic}" is new and no similar folders were found. Type a vault-relative folder path. Use "/" for vault root.`;

      try {
        const typed = await ctx.server.server.elicitInput({
          message: stage2Message,
          requestedSchema: {
            type: "object",
            properties: {
              folder: {
                type: "string",
                title: "Folder",
                description: `Vault-relative folder for topic "${topic}". Use "/" for vault root.`,
                default: defaultFolder,
              },
            },
            required: ["folder"],
          },
        });

        if (typed.action !== "accept") {
          return {
            ok: false,
            path: "",
            reason: `User ${typed.action}ed the folder prompt.`,
            trail,
          };
        }

        const raw = String(typed.content?.folder ?? "").trim();
        if (!raw) {
          return {
            ok: false,
            path: "",
            reason: "User did not provide a folder.",
            trail,
          };
        }
        chosenFolder = raw === "/" || raw === "." ? "" : raw;
      } catch (err) {
        trail.push(
          `[warn] elicitation (stage 2) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        elicitationFailed = true;
      }
    }

    if (chosenFolder !== null) {
      const entry = recordUse(vaultKey, topic, chosenFolder);
      trail.push(
        chosenFolder === ""
          ? `[routed] topic="${topic}" → (vault root) (newly registered via prompt)`
          : `[routed] topic="${topic}" → ${entry.folder} (newly registered via prompt)`,
      );
      return { ok: true, path: joinVaultPath(chosenFolder, name), reason: "prompted", trail };
    }
    // elicitationFailed === true → fall through to step 5 fallback below.
  }

  // 5. Fallback: topic-as-folder (no client elicitation support).
  const auto = defaultFolderForTopic(topic);
  const entry = recordUse(vaultKey, topic, auto);
  trail.push(
    `[routed] topic="${topic}" → ${entry.folder} (auto: client did not prompt user; topic registered)`,
  );
  if (suggestions.length) {
    trail.push(
      `[hint] vault has similar folders (${suggestions.map((s) => s.folder).join(", ")}). ` +
        `If one of those is the right home, call obsidian_register_topic to switch.`,
    );
  }
  return { ok: true, path: joinVaultPath(entry.folder, name), reason: "auto-fallback", trail };
}

function defaultFolderForTopic(topic: string): string {
  // "recipe-chinese" → "Recipe Chinese" → "Recipe Chinese"; we keep dashes
  // since that's the user's chosen format.
  return topic.replace(/^[\\/]+|[\\/]+$/g, "");
}

/**
 * Prepend variant. The CLI's `prepend` inserts after frontmatter, at the top.
 * To keep the final order [chunk1..chunkN] when the user asks to prepend, we
 * issue prepend calls in REVERSE order — last chunk first, first chunk last —
 * so each later prepend pushes earlier chunks down.
 */
async function runChunkedPrepend(args: {
  content: string;
  target: { file?: string; path?: string };
  vault?: string;
}): Promise<McpToolResult> {
  const { content, target, vault } = args;
  const chunks = splitForCli(content);

  if (chunks.length === 1) {
    return runText("prepend", { vault, params: { ...target, content: chunks[0] } });
  }

  const summary: string[] = [
    `Content was ${Buffer.byteLength(content, "utf8")} bytes; ` +
      `prepended in ${chunks.length} chunks (reverse order to preserve sequence).`,
  ];

  for (let i = chunks.length - 1; i >= 0; i--) {
    try {
      await runObsidian("prepend", {
        vault,
        params: { ...target, content: chunks[i] },
      });
      summary.push(`  chunk ${i + 1}/${chunks.length}: ok`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.push(`  chunk ${i + 1}/${chunks.length}: FAILED — ${msg}`);
      summary.push(
        `Note is in a partially-written state; chunks ${i + 2}..${chunks.length} were prepended.`,
      );
      return {
        content: [{ type: "text", text: summary.join("\n") }],
        isError: true,
      };
    }
  }

  return textResult(summary.join("\n"));
}

// ---------- tool definitions ----------

export interface ConfirmSpec {
  /** Headline shown in the confirmation prompt. */
  action: (input: any) => string;
  /** One-line detail line — typically restates the target. */
  detail: (input: any) => string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Present on tools that require user confirmation before running. */
  confirm?: ConfirmSpec;
  handler: (input: any, ctx: ToolContext) => Promise<McpToolResult>;
}

/** Optional `confirm` param injected into every sensitive tool's input schema. */
const ConfirmArg = {
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Set to true to skip the interactive confirmation prompt. " +
        "Use only when the caller has already confirmed with the user.",
    ),
};

export { errorResult, textResult };
export type { McpToolResult };

export const tools: ToolDef[] = [
  // ---------- file listing ----------
  {
    name: "obsidian_list_files",
    title: "List notes in vault",
    description:
      "Lists every note in the vault. Returns JSON by default. Useful as a first step to discover what exists.",
    inputSchema: {
      ...VaultArg,
      format: z
        .enum(["json", "paths", "csv", "tsv", "yaml"])
        .optional()
        .default("json")
        .describe("Output format. Defaults to JSON."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, format }) =>
      runJson("files", { vault, format }),
  },
  {
    name: "obsidian_list_folders",
    title: "List folder tree",
    description: "Displays the vault folder structure as a tree.",
    inputSchema: {
      ...VaultArg,
      format: z
        .enum(["tree", "paths", "json"])
        .optional()
        .default("tree"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, format }) =>
      format === "json"
        ? runJson("folders", { vault, format: "json" })
        : runText("folders", { vault, format }),
  },
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

  // ---------- note read / metadata ----------
  {
    name: "obsidian_read_note",
    title: "Read note content",
    description: "Returns the full markdown content of a note.",
    inputSchema: { ...VaultArg, ...FileTargetArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, file, path }) => {
      requireFileTarget({ file, path });
      return runText("read", { vault, params: { file, path } });
    },
  },
  {
    name: "obsidian_get_metadata",
    title: "Get note metadata",
    description:
      "Returns metadata for a note (frontmatter, tags, links, file stats) as JSON.",
    inputSchema: { ...VaultArg, ...FileTargetArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, file, path }) => {
      requireFileTarget({ file, path });
      return runJson("file", { vault, params: { file, path } });
    },
  },

  // ---------- note write ----------
  {
    name: "obsidian_create_note",
    title: "Create a new note",
    description:
      "Creates a new note. **Use `path` for the note location** — `name`, `file`, " +
      "and `filename` are NOT accepted (the schema is strict; unknown fields are rejected).\n\n" +
      "`path` is vault-root-relative. Missing folders along the path are auto-created by " +
      "the underlying Obsidian CLI.\n\n" +
      "If `path` contains no '/', the optional `topic` facet routes the note via the " +
      "vault-aware topic store (~/.obsidian-mcp/<vault>/topic-map.json):\n" +
      "  • Known topic → reuse stored folder (silent).\n" +
      "  • Unknown topic → MCP scans existing vault folders for similar names and " +
      "asks the user via elicitation: reuse a match, or specify a folder. The chosen " +
      "folder is recorded for next time.\n" +
      "  • Explicit paths in `path` (with '/') always bypass routing.\n" +
      "Use `obsidian_topic_stats` to inspect the learned map; " +
      "`obsidian_register_topic` to set a route programmatically.",
    inputSchema: {
      ...VaultArg,
      path: z
        .string()
        .min(1)
        .describe(
          "Vault-relative path or bare note name. Including a '/' selects an explicit " +
            "folder and bypasses topic routing; otherwise the note is created at the vault " +
            "root (or routed via `topic`). Missing folders are auto-created by the CLI.",
        ),
      topic: z
        .string()
        .optional()
        .describe(
          "Optional topic facet (e.g. 'recipe-chinese', 'meeting'). " +
            "Used to route the note via the persistent topic store. Ignored when `path` contains '/'.",
        ),
      folder: z
        .string()
        .optional()
        .describe(
          "Pre-decided folder for this topic (vault-relative). When supplied with " +
            "`topic`, the route is recorded without prompting the user. Useful for " +
            "agent-side prompts that already obtained the user's choice.",
        ),
      content: z
        .string()
        .optional()
        .describe("Initial markdown content to write into the note."),
      template: z
        .string()
        .optional()
        .describe("Template name to apply (mutually exclusive with content)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async ({ vault, path, topic, folder, content, template }, ctx) => {
      if (content && template) {
        return errorResult(
          new Error("Provide either `content` or `template`, not both."),
        );
      }

      const cleanPath = path.replace(/^[\\/]+/, "");
      const explicitInPath = /[\\/]/.test(cleanPath);
      const vaultKey = vault ?? "_default";
      const trail: string[] = [];

      let finalPath = cleanPath;

      if (explicitInPath) {
        trail.push(`[routed] explicit path → ${cleanPath}`);
      } else if (topic) {
        const routed = await routeForTopic({
          ctx,
          topic,
          name: cleanPath,
          vault,
          vaultKey,
          preDecidedFolder: folder,
        });
        if (!routed.ok) return errorResult(new Error(routed.reason));
        finalPath = routed.path;
        trail.push(...routed.trail);
      } else if (folder) {
        // No topic but explicit folder — just prepend, don't record (no key to store under).
        finalPath = joinVaultPath(folder, cleanPath);
        trail.push(`[routed] folder=${folder} (not stored — no topic given) → ${finalPath}`);
      } else {
        // No topic, no folder — write at vault root.
        trail.push(`[routed] vault root (no topic) → ${cleanPath}`);
      }

      const annotate = (result: McpToolResult): McpToolResult => {
        if (trail.length === 0) return result;
        return {
          ...result,
          content: [
            { type: "text", text: trail.join("\n") },
            ...result.content,
          ],
        };
      };

      // The CLI rejects `name=` when it contains '/' ("name cannot contain '/'.
      // Use path for a full file path."). Switch to `path=` for routed/explicit
      // folders, and ensure the `.md` suffix the CLI adds automatically for
      // `name=` is also present for `path=`.
      const useExplicitPath = /[\\/]/.test(finalPath);
      const pathForCli = useExplicitPath
        ? finalPath.toLowerCase().endsWith(".md")
          ? finalPath
          : `${finalPath}.md`
        : finalPath;
      const createTarget = useExplicitPath
        ? { path: pathForCli }
        : { name: finalPath };

      if (content && shouldChunk(content)) {
        return annotate(
          await runChunkedWrite({
            content,
            firstCommand: "create",
            firstParams: { ...createTarget, template },
            appendTarget: { path: pathForCli },
            vault,
          }),
        );
      }
      return annotate(
        await runText("create", {
          vault,
          params: { ...createTarget, content, template },
        }),
      );
    },
  },
  {
    name: "obsidian_append_note",
    title: "Append to a note",
    description: "Appends markdown content to the end of an existing note.",
    inputSchema: {
      ...VaultArg,
      ...FileTargetArg,
      content: z.string().min(1).describe("Markdown content to append."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async ({ vault, file, path, content }) => {
      requireFileTarget({ file, path });
      if (shouldChunk(content)) {
        return runChunkedWrite({
          content,
          firstCommand: "append",
          firstParams: { file, path },
          appendTarget: { file, path },
          vault,
        });
      }
      return runText("append", { vault, params: { file, path, content } });
    },
  },
  {
    name: "obsidian_prepend_note",
    title: "Prepend to a note",
    description:
      "Inserts content near the top of a note (after frontmatter, if present).",
    inputSchema: {
      ...VaultArg,
      ...FileTargetArg,
      content: z.string().min(1).describe("Markdown content to prepend."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async ({ vault, file, path, content }) => {
      requireFileTarget({ file, path });
      if (shouldChunk(content)) {
        return runChunkedPrepend({ content, target: { file, path }, vault });
      }
      return runText("prepend", { vault, params: { file, path, content } });
    },
  },
  {
    name: "obsidian_move_note",
    title: "Move or rename a note",
    description: "Moves or renames a note. Wikilinks across the vault are updated automatically.",
    inputSchema: {
      ...VaultArg,
      ...FileTargetArg,
      to: z
        .string()
        .min(1)
        .describe("Destination path (vault-relative). Include filename."),
      ...ConfirmArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    confirm: {
      action: () => "Move/rename a note",
      detail: ({ file, path, to }) => `${file ?? path} → ${to}`,
    },
    handler: async ({ vault, file, path, to }) => {
      requireFileTarget({ file, path });
      return runText("move", { vault, params: { file, path, to } });
    },
  },
  {
    name: "obsidian_delete_note",
    title: "Delete a note",
    description:
      "Moves a note to the system trash. Set `permanent: true` to bypass trash and delete immediately (irreversible).",
    inputSchema: {
      ...VaultArg,
      ...FileTargetArg,
      permanent: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, deletes immediately instead of moving to trash."),
      ...ConfirmArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    confirm: {
      action: ({ permanent }) =>
        permanent
          ? "PERMANENTLY delete a note (bypasses trash — irreversible)"
          : "Move a note to trash",
      detail: ({ file, path }) => `${file ?? path}`,
    },
    handler: async ({ vault, file, path, permanent }) => {
      requireFileTarget({ file, path });
      return runText("delete", {
        vault,
        params: { file, path },
        flags: permanent ? ["permanent"] : [],
      });
    },
  },

  // ---------- properties / frontmatter ----------
  {
    name: "obsidian_get_properties",
    title: "Get note frontmatter properties",
    description: "Returns the YAML frontmatter properties of a note as JSON.",
    inputSchema: { ...VaultArg, ...FileTargetArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, file, path }) => {
      requireFileTarget({ file, path });
      return runJson("properties", { vault, params: { file, path } });
    },
  },
  {
    name: "obsidian_set_property",
    title: "Set a frontmatter property",
    description: "Sets a frontmatter property on a note. Creates the frontmatter block if missing.",
    inputSchema: {
      ...VaultArg,
      ...FileTargetArg,
      name: z.string().min(1).describe("Property name (key)."),
      value: z.string().describe("Property value (string)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async ({ vault, file, path, name, value }) => {
      requireFileTarget({ file, path });
      return runText("property:set", {
        vault,
        params: { file, path, name, value },
      });
    },
  },
  {
    name: "obsidian_remove_property",
    title: "Remove a frontmatter property",
    description: "Removes a frontmatter property from a note.",
    inputSchema: {
      ...VaultArg,
      ...FileTargetArg,
      name: z.string().min(1).describe("Property name to remove."),
      ...ConfirmArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    confirm: {
      action: () => "Remove a frontmatter property",
      detail: ({ file, path, name }) => `${file ?? path} — property "${name}"`,
    },
    handler: async ({ vault, file, path, name }) => {
      requireFileTarget({ file, path });
      return runText("property:remove", {
        vault,
        params: { file, path, name },
      });
    },
  },

  // ---------- search ----------
  {
    name: "obsidian_search",
    title: "Full-text search",
    description: "Full-text search across the vault. Returns matching files.",
    inputSchema: {
      ...VaultArg,
      query: z.string().min(1).describe("Search query string."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of results to return."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, query, limit }) =>
      runJson("search", { vault, params: { query, limit } }),
  },
  {
    name: "obsidian_search_context",
    title: "Search with surrounding context",
    description:
      "Full-text search that returns surrounding lines of context for each hit.",
    inputSchema: {
      ...VaultArg,
      query: z.string().min(1),
      limit: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, query, limit }) =>
      runJson("search:context", { vault, params: { query, limit } }),
  },

  // ---------- tags ----------
  {
    name: "obsidian_list_tags",
    title: "List all tags",
    description: "Lists every tag used in the vault, with usage counts.",
    inputSchema: { ...VaultArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault }) => runJson("tags", { vault }),
  },
  {
    name: "obsidian_files_with_tag",
    title: "List files with a tag",
    description: "Lists every note tagged with the given tag.",
    inputSchema: {
      ...VaultArg,
      tag: z
        .string()
        .min(1)
        .describe("Tag name. Include the leading '#' (e.g. '#project')."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, tag }) =>
      runJson("tag", { vault, params: { tag } }),
  },
  {
    name: "obsidian_rename_tag",
    title: "Bulk rename a tag",
    description: "Renames a tag across every note in the vault.",
    inputSchema: {
      ...VaultArg,
      old: z.string().min(1).describe("Existing tag name (e.g. '#old')."),
      new: z.string().min(1).describe("New tag name (e.g. '#new')."),
      ...ConfirmArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    confirm: {
      action: () => "Rename a tag across the entire vault",
      detail: ({ old, new: newTag }) => `${old} → ${newTag}`,
    },
    handler: async ({ vault, old, new: newTag }) =>
      runText("tags:rename", { vault, params: { old, new: newTag } }),
  },

  // ---------- links ----------
  {
    name: "obsidian_get_links",
    title: "Get outgoing links",
    description: "Returns the outgoing wikilinks from a note.",
    inputSchema: { ...VaultArg, ...FileTargetArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, file, path }) => {
      requireFileTarget({ file, path });
      return runJson("links", { vault, params: { file, path } });
    },
  },
  {
    name: "obsidian_get_backlinks",
    title: "Get backlinks",
    description: "Returns notes that link to the target note.",
    inputSchema: { ...VaultArg, ...FileTargetArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault, file, path }) => {
      requireFileTarget({ file, path });
      return runJson("backlinks", { vault, params: { file, path } });
    },
  },
  {
    name: "obsidian_list_unresolved",
    title: "List unresolved links",
    description: "Finds wikilinks that point to non-existent notes.",
    inputSchema: { ...VaultArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault }) => runJson("unresolved", { vault }),
  },
  {
    name: "obsidian_list_orphans",
    title: "List orphan notes",
    description: "Finds notes that have no incoming wikilinks.",
    inputSchema: { ...VaultArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault }) => runJson("orphans", { vault }),
  },

  // ---------- daily notes ----------
  {
    name: "obsidian_daily_read",
    title: "Read today's daily note",
    description: "Returns the content of today's daily note.",
    inputSchema: { ...VaultArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault }) => runText("daily:read", { vault }),
  },
  {
    name: "obsidian_daily_append",
    title: "Append to today's daily note",
    description: "Appends content to today's daily note (creates it if missing).",
    inputSchema: {
      ...VaultArg,
      content: z.string().min(1).describe("Markdown content to append."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async ({ vault, content }) => {
      if (shouldChunk(content)) {
        // Resolve daily note path so the follow-up appends target the right file.
        try {
          const pathRes = await runObsidian("daily:path", { vault });
          const dailyPath = pathRes.stdout.trim();
          if (!dailyPath) {
            return errorResult(
              new Error(
                "Could not resolve daily note path for chunked write — daily:path returned empty.",
              ),
            );
          }
          return runChunkedWrite({
            content,
            firstCommand: "daily:append",
            firstParams: {},
            appendTarget: { path: dailyPath },
            vault,
          });
        } catch (err) {
          return errorResult(err);
        }
      }
      return runText("daily:append", { vault, params: { content } });
    },
  },
  {
    name: "obsidian_daily_path",
    title: "Get today's daily note path",
    description: "Returns the file path of today's daily note.",
    inputSchema: { ...VaultArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault }) => runText("daily:path", { vault }),
  },

  // ---------- plugins ----------
  {
    name: "obsidian_list_plugins",
    title: "List installed plugins",
    description: "Lists installed community + core plugins with enabled state.",
    inputSchema: { ...VaultArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault }) => runJson("plugins", { vault }),
  },
  {
    name: "obsidian_enable_plugin",
    title: "Enable a plugin",
    description: "Enables a community plugin by id.",
    inputSchema: {
      ...VaultArg,
      id: z.string().min(1).describe("Plugin id (e.g. 'dataview')."),
      ...ConfirmArg,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    confirm: {
      action: () => "Enable a community plugin (grants it code execution)",
      detail: ({ id }) => `plugin id: ${id}`,
    },
    handler: async ({ vault, id }) =>
      runText("plugin:enable", { vault, params: { id } }),
  },
  {
    name: "obsidian_disable_plugin",
    title: "Disable a plugin",
    description: "Disables a community plugin by id.",
    inputSchema: {
      ...VaultArg,
      id: z.string().min(1),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async ({ vault, id }) =>
      runText("plugin:disable", { vault, params: { id } }),
  },
  {
    name: "obsidian_reload_plugin",
    title: "Hot-reload a plugin",
    description: "Reloads a plugin's code (useful during plugin development).",
    inputSchema: {
      ...VaultArg,
      id: z.string().min(1),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async ({ vault, id }) =>
      runText("plugin:reload", { vault, params: { id } }),
  },

  // ---------- developer / advanced ----------
  {
    name: "obsidian_eval",
    title: "Evaluate JavaScript in Obsidian",
    description:
      "Runs arbitrary JavaScript inside the running Obsidian instance with access to the `app` object. " +
      "DANGEROUS: can read/modify any vault data and execute side effects. Use only when no narrower tool fits.",
    inputSchema: {
      ...VaultArg,
      code: z.string().min(1).describe("JavaScript code to evaluate."),
      ...ConfirmArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    confirm: {
      action: () => "Evaluate arbitrary JavaScript inside Obsidian",
      detail: ({ code }) => {
        const oneLine = code.replace(/\s+/g, " ").trim();
        return oneLine.length > 140 ? oneLine.slice(0, 140) + "…" : oneLine;
      },
    },
    handler: async ({ vault, code }) => {
      if (shouldChunk(code)) {
        return errorResult(
          new Error(
            `Eval code is ${Buffer.byteLength(code, "utf8")} bytes, over the ` +
              `${getLimit()}-byte argv limit on this platform. JavaScript cannot ` +
              `be chunked — write the script to a note via append (which auto-chunks) ` +
              `then load it inside a smaller eval, e.g. ` +
              `\`new Function(await app.vault.adapter.read('script.md'))()\`.`,
          ),
        );
      }
      return runText("eval", { vault, params: { code } });
    },
  },
  {
    name: "obsidian_dev_screenshot",
    title: "Capture Obsidian screenshot",
    description:
      "Returns a base64-encoded PNG screenshot of the running Obsidian window.",
    inputSchema: { ...VaultArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ vault }) => runText("dev:screenshot", { vault }),
  },
  {
    name: "obsidian_dev_errors",
    title: "Get JavaScript errors",
    description: "Returns recent JS errors from the Obsidian DevTools console.",
    inputSchema: { ...VaultArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault }) => runText("dev:errors", { vault }),
  },
  {
    name: "obsidian_dev_console",
    title: "Get console output",
    description: "Returns recent console messages from Obsidian DevTools.",
    inputSchema: { ...VaultArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault }) => runText("dev:console", { vault }),
  },

  // ---------- topic store (faceted classification) ----------
  {
    name: "obsidian_topic_stats",
    title: "Show learned topic → folder routes",
    description:
      "Returns the persistent topic store for the given vault — every topic the MCP " +
      "has routed, the folder it landed in, and how often it's been used. Sorted by usage. " +
      "Use this before calling `obsidian_create_note` with a `topic` so you can pick a " +
      "topic that's already known to the vault.",
    inputSchema: { ...VaultArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ vault }) => {
      const stats = getStats(vault ?? "_default");
      return textResult(JSON.stringify(stats, null, 2), stats);
    },
  },
  {
    name: "obsidian_register_topic",
    title: "Register or update a topic → folder route",
    description:
      "Programmatically registers (or overwrites) a topic → folder mapping in the " +
      "persistent topic store. Use when the user has explicitly told you where a kind " +
      "of note should live, so future writes for the same topic land there silently.",
    inputSchema: {
      ...VaultArg,
      topic: z.string().min(1).describe("Topic key (e.g. 'recipe-chinese')."),
      folder: z
        .string()
        .min(1)
        .describe("Vault-relative folder where this topic's notes should live."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async ({ vault, topic, folder }) => {
      const cleaned = folder.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
      if (cleaned.split(/[\\/]+/).some((p: string) => p === "..")) {
        return errorResult(new Error("Folder must be vault-relative; '..' not allowed."));
      }
      const entry = recordUse(vault ?? "_default", topic, cleaned);
      return textResult(
        `Registered: "${topic}" → ${entry.folder} (uses: ${entry.uses}).`,
        entry as unknown as Record<string, unknown>,
      );
    },
  },
  {
    name: "obsidian_remove_topic",
    title: "Remove a topic from the persistent store",
    description:
      "Forgets a topic → folder mapping. Existing notes in the folder are not touched.",
    inputSchema: {
      ...VaultArg,
      topic: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async ({ vault, topic }) => {
      const removed = removeTopicEntry(vault ?? "_default", topic);
      return textResult(
        removed ? `Removed topic "${topic}".` : `Topic "${topic}" was not in the store.`,
      );
    },
  },
  {
    name: "obsidian_version",
    title: "Get Obsidian CLI version",
    description: "Returns the version of the Obsidian CLI binary in use.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async () => runText("version"),
  },
  {
    name: "obsidian_help",
    title: "Show CLI help",
    description:
      "Shows the underlying `obsidian help` output — useful when a command behaves unexpectedly.",
    inputSchema: {
      all: z.boolean().optional().describe("Pass --all to include hidden commands."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ all }) =>
      runText("help", { flags: all ? ["--all"] : [] }),
  },
];
