import { z } from "zod";
import { ObsidianCliError, parseJsonOrText, runObsidian } from "./exec.js";

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

// ---------- tool definitions ----------

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
  handler: (input: any) => Promise<McpToolResult>;
}

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
      "Creates a new note. `name` is the path (relative to the vault root), with or without the .md extension.",
    inputSchema: {
      ...VaultArg,
      name: z
        .string()
        .min(1)
        .describe("Note path/name relative to the vault root."),
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
    handler: async ({ vault, name, content, template }) => {
      if (content && template) {
        return errorResult(
          new Error("Provide either `content` or `template`, not both."),
        );
      }
      return runText("create", {
        vault,
        params: { name, content, template },
      });
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
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
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
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
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
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
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
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
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
    handler: async ({ vault, content }) =>
      runText("daily:append", { vault, params: { content } }),
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
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
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
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async ({ vault, code }) =>
      runText("eval", { vault, params: { code } }),
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

  // ---------- meta ----------
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
