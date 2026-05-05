#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tools } from "./tools.js";

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
        "`vault` parameter; when omitted, the most recently focused vault is used.",
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
      tool.handler,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Helpful banner on stderr (stdout is reserved for the MCP protocol).
  process.stderr.write(
    `obsidian-mcp ready — ${tools.length} tools registered\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
