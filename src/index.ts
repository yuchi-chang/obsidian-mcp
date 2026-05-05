#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureConfirmed } from "./confirm.js";
import { errorResult, tools, type ToolDef } from "./tools.js";

function buildHandler(server: McpServer, tool: ToolDef): ToolDef["handler"] {
  if (!tool.confirm) return tool.handler;
  const spec = tool.confirm;
  return async (input: any) => {
    const outcome = await ensureConfirmed(server, spec, input);
    if (!outcome.ok) {
      return errorResult(new Error(outcome.reason ?? "Confirmation required."));
    }
    return tool.handler(input);
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
        "(Settings → General → Command line interface → Register CLI). " +
        "File-targeting tools accept either `file` (wikilink-style note name) " +
        "or `path` (vault-relative file path). Most tools accept an optional " +
        "`vault` parameter; when omitted, the most recently focused vault is used. " +
        "Sensitive tools (delete, move, rename-tag, remove-property, eval, enable-plugin) " +
        "request user confirmation before running — interactively via MCP elicitation when " +
        "the client supports it, otherwise by requiring `confirm: true` in the tool input.",
    },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
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
