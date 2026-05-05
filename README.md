# obsidian-mcp

MCP server that wraps the official [Obsidian CLI](https://obsidian.md/help/cli) so an LLM agent can drive a running Obsidian instance — read/write notes, search, manage frontmatter, navigate links, run plugins, and more.

This server is a thin, comprehensive wrapper. Every tool maps 1:1 to an `obsidian` CLI command.

## Prerequisites

1. **Obsidian must be running.** The CLI talks to the live app over IPC; it does not read the vault on disk directly.
2. **Register the CLI binary.** In Obsidian: *Settings → General → Command line interface → Register CLI*. Obsidian will add `obsidian` to your `PATH`.
3. **Verify**: `obsidian version` prints the CLI version.

## Install

Two paths depending on whether you want to build it yourself or grab a pre-published version from npm.

### Option A — Clone & build (works today)

Clone the repo and build locally, then point Claude Code at the built file:

```bash
git clone https://github.com/yuchichang/obsidian-mcp.git
cd obsidian-mcp
npm install
npm run build
```

Register it with Claude Code (one command):

```bash
# Add (user scope — available across all projects)
claude mcp add -s user obsidian -- node /absolute/path/to/obsidian-mcp/dist/index.js

# Remove
claude mcp remove obsidian

# List configured servers
claude mcp list
```

`-s user` registers it for your whole user account. Use `-s project` to commit it to the repo's `.mcp.json` instead, or `-s local` for the current project only (default).

Or write it into `.mcp.json` manually:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mcp/dist/index.js"]
    }
  }
}
```

### Option B — Install from npm (zero-build)

> **Prerequisite:** the package must already be published to npm. The maintainer publishes once via `npm publish`; all subsequent users get it via `npx` automatically. If you forked this repo and want this flow under your own scope, change `name` in `package.json` to `@<your-npm-username>/obsidian-mcp`, then `npm publish`.

Once published, no clone or build needed:

```bash
claude mcp add -s user obsidian -- npx -y @yuchichang/obsidian-mcp
```

Or in `.mcp.json` / Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@yuchichang/obsidian-mcp"]
    }
  }
}
```

### Override the CLI path

If `obsidian` isn't on `PATH`, set the `OBSIDIAN_CLI` env var. Works with either install path:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mcp/dist/index.js"],
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

## Sensitive operations & user confirmation

The following tools are gated behind a user-confirmation step:

| Tool | Reason |
|---|---|
| `obsidian_delete_note` | Removes data (especially with `permanent: true`). |
| `obsidian_move_note` | Renames + rewrites wikilinks across the vault. |
| `obsidian_remove_property` | Removes frontmatter data. |
| `obsidian_rename_tag` | Bulk-rewrites tags across every note. |
| `obsidian_enable_plugin` | Grants a community plugin code execution. |
| `obsidian_eval` | Runs arbitrary JavaScript inside Obsidian. |

How the gate works:

1. **MCP elicitation (preferred).** If the connected client supports the [`elicitation`](https://modelcontextprotocol.io/specification/draft) capability (Claude Code does), the server sends an `elicitation/create` request and the client shows the user a *Proceed?* prompt with the action and target spelled out. Only `accept + confirm: true` proceeds.
2. **Explicit `confirm: true` parameter.** Every sensitive tool's input schema includes an optional `confirm: boolean`. Passing `confirm: true` skips the elicitation prompt — use this only when the caller has already obtained user approval.
3. **Refusal fallback.** If the client doesn't support elicitation and `confirm: true` was not provided, the tool returns an `isError` result that names the action and instructs the caller to retry with `confirm: true`.

### Bypass for batch / automation

```
OBSIDIAN_MCP_AUTO_CONFIRM=1
```

Set this env var (in your MCP client's `env` block) to skip every confirmation prompt. Use only in fully-trusted automation contexts.

## Long content & argv limits

The Obsidian CLI does not (yet) support reading parameter values from stdin or from files — every value travels on the command line. That collides with platform limits:

| Platform | Practical command-line limit |
|---|---|
| Windows (cmd.exe) | ~8,191 chars total |
| macOS / Linux | `ARG_MAX` (typically 128 KB – 2 MB) |

To stay safe, the server **automatically chunks** long writes:

| Tool | Chunking strategy |
|---|---|
| `obsidian_create_note` | First chunk via `create`, remaining chunks via `append`. |
| `obsidian_append_note` | Sequential `append` calls. |
| `obsidian_prepend_note` | `prepend` calls in reverse order so final order is preserved. |
| `obsidian_daily_append` | Resolves the daily note path, then chunked append. |
| `obsidian_eval` | **Not chunked** — JS can't be split. Returns an error suggesting the script-via-note workaround. |

Splits happen at line boundaries when possible; oversized single lines fall back to UTF-8-safe character boundaries. Reassembled content is byte-identical to the original.

Configure the per-call byte threshold (defaults: 6,000 on Windows, 100,000 elsewhere):

```
OBSIDIAN_MCP_MAX_ARG_BYTES=4000
```

If a chunk in the middle of a multi-chunk write fails, the server returns `isError` with a clear message stating which chunks made it to disk so the caller can recover.

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
