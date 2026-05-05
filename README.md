# obsidian-mcp

MCP server that wraps the official [Obsidian CLI](https://obsidian.md/help/cli) so an LLM agent can drive a running Obsidian instance — read/write notes, search, manage frontmatter, navigate links, run plugins, and more.

This server is a thin, comprehensive wrapper. Every tool maps 1:1 to an `obsidian` CLI command.

## Prerequisites

1. **Obsidian must be running.** The CLI talks to the live app over IPC; it does not read the vault on disk directly.
2. **Register the CLI binary.** In Obsidian: *Settings → General → Command line interface → Register CLI*. Obsidian will add `obsidian` to your `PATH`.
3. **Verify**: `obsidian version` prints the CLI version.

## Install

```bash
npm install
npm run build
```

This produces `dist/index.js`, the stdio MCP server entrypoint.

## Configure your MCP client

### Claude Code / `.mcp.json`

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["E:/AgentProject/obsidian-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop / `claude_desktop_config.json`

Same shape as above. Restart Claude Desktop after saving.

### Override the CLI path

If `obsidian` isn't on `PATH`, set the `OBSIDIAN_CLI` env var in your client config:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["E:/AgentProject/obsidian-mcp/dist/index.js"],
      "env": {
        "OBSIDIAN_CLI": "C:/Users/you/AppData/Local/Obsidian/obsidian.cmd"
      }
    }
  }
}
```

## Tools

### Vault & files

| Tool | Wraps |
|---|---|
| `obsidian_list_files` | `obsidian files` |
| `obsidian_list_folders` | `obsidian folders` |
| `obsidian_read_note` | `obsidian read` |
| `obsidian_get_metadata` | `obsidian file` |
| `obsidian_create_note` | `obsidian create` |
| `obsidian_append_note` | `obsidian append` |
| `obsidian_prepend_note` | `obsidian prepend` |
| `obsidian_move_note` | `obsidian move` |
| `obsidian_delete_note` | `obsidian delete` (`permanent` flag supported) |

### Frontmatter properties

| Tool | Wraps |
|---|---|
| `obsidian_get_properties` | `obsidian properties` |
| `obsidian_set_property` | `obsidian property:set` |
| `obsidian_remove_property` | `obsidian property:remove` |

### Search

| Tool | Wraps |
|---|---|
| `obsidian_search` | `obsidian search` |
| `obsidian_search_context` | `obsidian search:context` |

### Tags & links

| Tool | Wraps |
|---|---|
| `obsidian_list_tags` | `obsidian tags` |
| `obsidian_files_with_tag` | `obsidian tag` |
| `obsidian_rename_tag` | `obsidian tags:rename` |
| `obsidian_get_links` | `obsidian links` |
| `obsidian_get_backlinks` | `obsidian backlinks` |
| `obsidian_list_unresolved` | `obsidian unresolved` |
| `obsidian_list_orphans` | `obsidian orphans` |

### Daily notes

| Tool | Wraps |
|---|---|
| `obsidian_daily_read` | `obsidian daily:read` |
| `obsidian_daily_append` | `obsidian daily:append` |
| `obsidian_daily_path` | `obsidian daily:path` |

### Plugins

| Tool | Wraps |
|---|---|
| `obsidian_list_plugins` | `obsidian plugins` |
| `obsidian_enable_plugin` | `obsidian plugin:enable` |
| `obsidian_disable_plugin` | `obsidian plugin:disable` |
| `obsidian_reload_plugin` | `obsidian plugin:reload` |

### Developer / advanced

| Tool | Wraps | Notes |
|---|---|---|
| `obsidian_eval` | `obsidian eval` | ⚠️ Runs arbitrary JS inside Obsidian. Treat as destructive. |
| `obsidian_dev_screenshot` | `obsidian dev:screenshot` | Returns base64 PNG. |
| `obsidian_dev_errors` | `obsidian dev:errors` |  |
| `obsidian_dev_console` | `obsidian dev:console` |  |

### Meta

| Tool | Wraps |
|---|---|
| `obsidian_version` | `obsidian version` |
| `obsidian_help` | `obsidian help` |

## Conventions

- **Targeting a note** — file-targeting tools accept either:
  - `file` — wikilink-style note name (e.g. `"My Note"`), or
  - `path` — vault-relative file path (e.g. `"Folder/My Note.md"`).
- **Multi-vault setups** — every tool accepts an optional `vault` parameter. When omitted, the most recently focused vault is used.
- **Output format** — list/search/metadata tools default to JSON for easy machine parsing.

## Develop

```bash
npm run dev      # tsc --watch
npm run inspect  # launch MCP Inspector against the built server
node scripts/smoke-test.mjs   # initialize + tools/list smoke test
```

## How it works

`runObsidian()` (`src/exec.ts`) shell-quotes arguments, invokes the `obsidian` binary via `child_process.exec`, and parses stdout. Most read-style tools request `format=json`; results are parsed to `structuredContent` for clients that consume structured tool output, while still returning a text representation in `content`.

Tool registry lives in `src/tools.ts` — adding a new wrapped command is a single entry there.

## Reference

- Obsidian CLI: https://obsidian.md/help/cli
- MCP spec: https://modelcontextprotocol.io
