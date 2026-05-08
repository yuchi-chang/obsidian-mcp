# Organize Root Notes — Design

**Date:** 2026-05-08
**Status:** Approved (brainstorming complete)
**Owner:** yuchi

## Problem

Notes created via `obsidian_create_note` without a `topic` land at the vault root with no follow-up organization. Over time the vault root accumulates orphaned `.md` files that should belong to subject folders. There is currently no MCP-side mechanism to scan root, classify by content, and route to existing or new folders.

## Goals

- Surface every loose root-level `.md` to the calling LLM with enough context to classify it.
- Let the caller (Claude) decide the target folder per note based on content; fall back to creating a new folder when no good match exists.
- Apply the resulting plan in one batch with a dry-run preview, an explicit confirmation, and per-item failure isolation.
- Reuse the result to populate the persistent topic store so future single-note writes auto-route.

## Non-goals

- Recursive scanning of subfolders. Only literal vault-root `.md` files are in scope.
- MCP-side classification heuristics. The caller LLM owns "which folder fits this content."
- Automatic execution without confirmation.
- Migration of existing topic-map entries that conflict with new routings (handled implicitly by `recordUse` overwriting on apply).

## Architecture

```
src/
├── tools.ts            register two new ToolDefs, delegate to modules below
├── rootScan.ts         (new) read-only: list root + extract preview metadata
├── organize.ts         (new) write: validate plan, dry-run, apply moves
├── folderSearch.ts     reuse listVaultFolders for is_new_folder detection
├── topicStore.ts       reuse recordUse for post-apply topic registration
└── exec.ts             reuse runObsidian
```

`rootScan.ts` and `organize.ts` are pure orchestration on top of `runObsidian`. Both export a small set of named functions that the tool handlers call. This keeps handlers thin and modules unit-testable with mocked CLI.

## Tool 1 — `obsidian_scan_root`

### Purpose
List `.md` files at the vault root with frontmatter and a body preview, so the caller can classify each one.

### Input

```ts
{
  vault?: string,
  ignore?: string[],          // glob array against vault-relative path; default []
  preview_bytes?: number,     // default 800
  max_files?: number,         // default 200; safety cap
}
```

`ignore` is a glob array (not a single string) to keep the schema future-proof for richer matchers without breaking callers. Initial implementation supports `*`/`**` and literal segments — micromatch-equivalent. Globs match the full vault-relative path.

### Behaviour

1. Run `obsidian files --format=json --vault=…`; parse the JSON list.
2. Filter to entries whose `path` does not contain `/` and ends with `.md` (i.e. literal root level).
3. Apply `ignore` globs.
4. For each surviving entry, run `obsidian read` (concurrency limited to 5).
5. Parse each result:
   - Extract YAML frontmatter delimited by `---` if present; pull `tags`, `aliases`, `topic` if those keys exist.
   - Compute `body` as the markdown after frontmatter; truncate to `preview_bytes` on UTF-8 boundary.
   - Record `body_full_bytes` so the caller knows whether the preview is partial.
6. If filtered count exceeds `max_files`, return the first `max_files` entries with `truncated: true`.

### Output

```jsonc
{
  "scanned_at": "2026-05-08T07:06:08Z",
  "total_root_files": 23,
  "returned": 23,
  "truncated": false,
  "ignored_count": 2,
  "files": [
    {
      "path": "WebRTC 連線建立流程.md",
      "size_bytes": 4123,
      "modified_at": "2026-05-08T07:06:08Z",
      "frontmatter": { "tags": ["webrtc"], "aliases": null, "topic": null },
      "preview": "# WebRTC 連線建立流程\n\nWebRTC 的連線建立...",
      "body_full_bytes": 4001,
      "read_error": null,
      "frontmatter_error": null
    }
  ]
}
```

When a single file fails to read or parse, that entry is still returned with `preview: null` + `read_error` populated (or `frontmatter: null` + `frontmatter_error`). Other entries are unaffected.

## Tool 2 — `obsidian_organize_apply`

### Purpose
Validate a routing plan, return a dry-run preview, and on confirmation apply the moves and (optionally) register topics.

### Input

```ts
{
  vault?: string,
  plan: Array<{
    path: string,             // vault-root-relative; must be root level
    target_folder: string,    // vault-relative; "" or "/" means keep at root
    topic?: string,           // optional; recorded in topic store on success
    reason?: string           // optional; ignored by tool, logged for audit
  }>,
  dry_run: boolean,           // required — no default
  register_topics?: boolean,  // default true
  confirm?: boolean           // standard ConfirmArg; required when dry_run=false
}
```

`plan` must contain at least one entry. `dry_run` is required (no default) so the caller cannot accidentally apply by forgetting the flag.

### Validation (shared between dry-run and apply)

1. **Per-entry structure:**
   - `path` must not contain `/` (root level only) and must end with `.md`.
   - `target_folder` must not contain `..` segments and must not be absolute.
   - Normalize `target_folder` by stripping leading/trailing slashes; treat `""`, `"/"`, and `"."` as "vault root."
2. **Plan-level:** reject if any `path` appears twice.
3. **Folder existence:** call `listVaultFolders()` once; mark `is_new_folder: true` for entries whose normalized `target_folder` is non-empty and not in the list.
4. **Conflict detection:** for each entry, compute `to = target_folder + "/" + basename(path)` (or just `basename` when keeping at root). If `to !== path` and a file already exists at `to`, mark `status: "conflict"`.
5. **No-op detection:** if `target_folder === ""` and `path` is already at root, mark `status: "noop"`.

### Output (same shape for dry-run and apply)

```jsonc
{
  "dry_run": true,
  "summary": {
    "total": 12,
    "will_move": 9,
    "will_create_folders": 3,
    "noop": 2,
    "conflict": 1,
    "applied": 0,
    "failed": 0
  },
  "new_folders": ["webrtc", "linux/kernel"],
  "items": [
    {
      "path": "WebRTC 連線建立流程.md",
      "target_folder": "webrtc",
      "topic": "webrtc",
      "to": "webrtc/WebRTC 連線建立流程.md",
      "is_new_folder": true,
      "status": "ok",
      "error": null
    },
    {
      "path": "舊筆記.md",
      "target_folder": "Notes",
      "to": "Notes/舊筆記.md",
      "status": "conflict",
      "error": "Destination already exists"
    }
  ]
}
```

`status` values: `ok`, `conflict`, `noop`, `failed`. The semantics shift by mode:

- **Dry-run:** `status` is the predicted outcome — `ok` means "this move would succeed," `conflict`/`noop` mean "would be skipped." `failed` is never produced.
- **Apply:** `status` is the actual outcome — `ok` means "the move succeeded," `failed` means "attempted and CLI returned an error."

Declined confirmation prompts return a standard refusal result (per the existing `ConfirmArg` pattern) — the apply step does not run and no `items` array is produced.

### Apply phase

When `dry_run === false`:

1. Standard `ConfirmArg` flow: if `confirm !== true`, return a confirmation request describing the action (`"Reorganize N root notes"`) and a one-line detail (`"N note(s) → M folder(s)"`).
2. Run validation as above. If any pre-execution validation fails (structure errors, duplicates), return the error result without touching the vault.
3. For each entry with `status === "ok"`:
   - Call `runObsidian("move", { params: { path: from, to } })`.
   - On success: increment `summary.applied`. If `entry.topic` is set and `register_topics !== false`, call `recordUse(vaultKey, topic, target_folder)`. If `recordUse` throws, log a warning into the result trail but do not fail the entry.
   - On failure: set `status: "failed"`, write the CLI error message into `error`, increment `summary.failed`. Continue with the next entry.
4. Entries with `status` of `conflict` or `noop` are reported as-is and skipped.

### Folder creation

Whether the CLI's `move` command auto-creates intermediate folders is verified during implementation. Three contingencies:

- **Auto-create works:** no extra logic.
- **CLI rejects missing destination:** add `ensureFolders(folders: string[])` to `organize.ts` that creates a placeholder via `obsidian create` and immediately deletes it; called once before the move loop, only on the unique `new_folders` set.
- **CLI move neither creates nor errors usefully:** `ensureFolders` falls back to `obsidian eval` with `app.vault.createFolder(path)`.

The chosen path is invisible to callers — the public output shape and contract are identical.

## Topic store side effect

After a successful move where `entry.topic` is set and `register_topics !== false`, the apply step calls `recordUse(vaultKey, topic, target_folder)`. This means a successful organize run also teaches the topic store, so future `obsidian_create_note` calls with that topic route silently.

`recordUse` overwrites existing folder bindings — that is the intended behaviour when an organize run reroutes a topic.

## Error handling summary

| Layer | Failure | Behaviour |
|---|---|---|
| Scan | `obsidian files` fails | Throw `ObsidianCliError`; caller sees standard error result |
| Scan | Single file `read` fails | Entry returned with `read_error`; other entries continue |
| Scan | Frontmatter YAML invalid | Entry returned with `frontmatter_error`; preview still extracted |
| Scan | No root `.md` files | Return `files: []`, not an error |
| Apply | Empty `plan` | Reject (zod `.min(1)`) |
| Apply | Structural validation fails | Reject entire batch before any write |
| Apply | Conflict | Skip, status=`conflict`, others continue |
| Apply | Single move fails | Skip, status=`failed`, others continue |
| Apply | `recordUse` throws | Warn into trail, do not fail the entry |
| Apply | User declines confirm | Standard `ConfirmArg` refusal — apply does not run |

## Testing

### Unit (Vitest)

`src/__tests__/rootScan.test.ts` — mocks `runObsidian`:

1. Mixed root + subfolder notes → only root returned.
2. `ignore` globs filter daily notes.
3. `preview_bytes` truncation respects UTF-8 boundaries.
4. Frontmatter parsing: present, absent, malformed.
5. `max_files` triggers `truncated: true`.
6. Single `read` failure isolates to one entry.

`src/__tests__/organize.test.ts` — pure validation + mocked CLI:

1. Duplicate `path` → reject.
2. `path` containing `/` → reject.
3. `target_folder` with `..` → reject.
4. `target_folder=""` + path already at root → `noop`.
5. Conflict detection (destination already exists).
6. `is_new_folder` detection.
7. Apply success path: 9 moves + 9 `recordUse` calls.
8. Third move fails: third entry `status="failed"`, no `recordUse` for it; others succeed.
9. `register_topics=false`: no `recordUse` calls.
10. Dry-run: 0 moves, 0 `recordUse`, output shape matches apply.

### Integration

`scripts/organize-test.mjs` — manual dev smoke test against a real vault. Resolves the `move`-creates-folders question and exercises the full caller flow. Not part of CI.

## tools.ts registration

Two new entries in `src/tools.ts`:

- `obsidian_scan_root`: `readOnlyHint: true`. No `confirm` spec.
- `obsidian_organize_apply`: `destructiveHint: true`, `idempotentHint: false`. Includes `ConfirmArg` and a `confirm` ConfirmSpec describing the batch.

## README

Add a "Bulk organize root notes" section under the existing "Topic-aware routing" docs, with a three-step caller example: scan → classify → apply (dry-run then confirm).

## Open items resolved during implementation

- Whether `obsidian move` auto-creates intermediate folders. Drives the `ensureFolders` fallback choice.
- Glob library: micromatch vs. tiny in-tree implementation. Decide based on whether other modules need it.
