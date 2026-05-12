#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureConfirmed } from "./confirm.js";
import { errorResult, tools, type ToolDef } from "./tools.js";

function buildHandler(server: McpServer, tool: ToolDef) {
  const ctx = { server };
  if (!tool.confirm) {
    return async (input: any) => tool.handler(input, ctx);
  }
  const spec = tool.confirm;
  return async (input: any) => {
    if (spec.skipWhen?.(input)) {
      return tool.handler(input, ctx);
    }
    const outcome = await ensureConfirmed(server, spec, input);
    if (!outcome.ok) {
      return errorResult(new Error(outcome.reason ?? "Confirmation required."));
    }
    return tool.handler(input, ctx);
  };
}

async function main() {
  const server = new McpServer(
    {
      name: "obsidian-mcp",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
      instructions:
        "Wraps the official Obsidian CLI (https://obsidian.md/help/cli). " +
        "Obsidian must be running and the CLI must be registered " +
        "(Settings → General → Command line interface → Register CLI).\n\n" +
        "WHEN TO USE THESE TOOLS:\n" +
        "- The user explicitly mentions Obsidian, their vault, or their notes " +
        "(e.g. 'search my notes', 'check Obsidian', '查我的筆記', '查 obsidian', " +
        "'我筆記裡有沒有...', 'create a daily note', 'add to my vault').\n" +
        "- The user references a wikilink ([[Note Name]]) or a vault-relative path.\n" +
        "- The user asks to read/write/search content that clearly lives in their " +
        "personal knowledge base rather than the current code project.\n\n" +
        "WHEN NOT TO USE:\n" +
        "- General knowledge questions ('what is X', 'explain Y', 'how does Z work') — " +
        "answer from your own knowledge instead of querying the vault.\n" +
        "- Coding tasks on the current project that don't involve the user's notes.\n" +
        "- Ambiguous requests like '查 X' / 'search X' that do NOT mention notes, " +
        "vault, or Obsidian — do not invoke these tools at all. Answer from your " +
        "own knowledge. Do not ask the user whether they want a vault search; " +
        "treat the absence of an explicit mention as an explicit 'no'.\n\n" +
        "USAGE NOTES:\n" +
        "- File-targeting tools accept either `file` (wikilink-style note name) " +
        "or `path` (vault-relative file path). Most tools accept an optional " +
        "`vault` parameter; when omitted, the most recently focused vault is used.\n" +
        "- Sensitive tools (delete, move, rename-tag, remove-property, eval, enable-plugin) " +
        "request user confirmation before running — interactively via MCP elicitation when " +
        "the client supports it, otherwise by requiring `confirm: true` in the tool input.",
    },
  );

  for (const tool of tools) {
    // Wrap the raw shape in a strict ZodObject so the SDK rejects unknown
    // fields at validation time. Without `.strict()`, zod silently drops
    // unknown keys — a caller that types `name` instead of `path` would
    // succeed with the typo erased, producing a "false positive" write at
    // the wrong location. Strict mode surfaces such mistakes immediately.
    const strictInputSchema = z.object(tool.inputSchema).strict();
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: strictInputSchema,
        annotations: tool.annotations,
      },
      buildHandler(server, tool),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const sensitive = tools.filter((t) => t.confirm).length;
  // Helpful banner on stderr (stdout is reserved for the MCP protocol).
  process.stderr.write(
    `obsidian-mcp ready — ${tools.length} tools registered (${sensitive} require confirmation)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
