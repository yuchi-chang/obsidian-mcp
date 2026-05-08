// Persistent topic → folder map, stored per vault under
// ~/.obsidian-mcp/<vaultKey>/topic-map.json. Survives across sessions so the
// MCP can learn the user's vault conventions over time.
//
// Why a side file (vs. a vault-internal file): we don't have a reliable way
// to discover the vault's filesystem path without invoking the sensitive
// `obsidian eval` tool. The user's home directory is always reachable.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_VERSION = 1;
const ROOT_DIR = join(homedir(), ".obsidian-mcp");

export interface TopicEntry {
  folder: string;
  uses: number;
  createdAt: string;  // ISO date
  lastUsedAt: string; // ISO date
}

export interface TopicStore {
  version: number;
  topics: Record<string, TopicEntry>;
}

const cache = new Map<string, TopicStore>();

function vaultDir(vaultKey: string): string {
  // Sanitize vault key — keep only word chars / dash / space. Dots and
  // slashes are stripped to prevent parent-traversal attempts (".." etc).
  const safe = vaultKey.replace(/[^\w\- ]+/g, "_");
  return join(ROOT_DIR, safe || "_default");
}

export function storePath(vaultKey: string): string {
  return join(vaultDir(vaultKey), "topic-map.json");
}

export function loadStore(vaultKey: string): TopicStore {
  if (cache.has(vaultKey)) return cache.get(vaultKey)!;
  const file = storePath(vaultKey);
  let store: TopicStore = { version: STORE_VERSION, topics: {} };
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.topics === "object" &&
        parsed.topics !== null
      ) {
        store = {
          version: typeof parsed.version === "number" ? parsed.version : STORE_VERSION,
          topics: parsed.topics,
        };
      }
    } catch {
      // Corrupted file → start fresh; preserve the bad file once for diagnostics.
      try {
        renameSync(file, file + `.bad-${Date.now()}`);
      } catch {}
    }
  }
  cache.set(vaultKey, store);
  return store;
}

function atomicWrite(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

export function saveStore(vaultKey: string, store: TopicStore): void {
  cache.set(vaultKey, store);
  atomicWrite(storePath(vaultKey), JSON.stringify(store, null, 2));
}

export function recordUse(
  vaultKey: string,
  topic: string,
  folder: string,
  now: Date = new Date(),
): TopicEntry {
  const store = loadStore(vaultKey);
  const iso = now.toISOString();
  const existing = store.topics[topic];
  const entry: TopicEntry = existing
    ? { ...existing, folder, uses: existing.uses + 1, lastUsedAt: iso }
    : { folder, uses: 1, createdAt: iso, lastUsedAt: iso };
  store.topics[topic] = entry;
  saveStore(vaultKey, store);
  return entry;
}

export function removeTopic(vaultKey: string, topic: string): boolean {
  const store = loadStore(vaultKey);
  if (!(topic in store.topics)) return false;
  delete store.topics[topic];
  saveStore(vaultKey, store);
  return true;
}

export function getStats(vaultKey: string): {
  vaultKey: string;
  storePath: string;
  totalTopics: number;
  totalWrites: number;
  topics: Array<TopicEntry & { topic: string }>;
} {
  const store = loadStore(vaultKey);
  const topics = Object.entries(store.topics)
    .map(([topic, entry]) => ({ topic, ...entry }))
    .sort((a, b) => b.uses - a.uses);
  return {
    vaultKey,
    storePath: storePath(vaultKey),
    totalTopics: topics.length,
    totalWrites: topics.reduce((s, t) => s + t.uses, 0),
    topics,
  };
}

/** Reset cache — only used by tests. */
export function _clearCache(): void {
  cache.clear();
}
