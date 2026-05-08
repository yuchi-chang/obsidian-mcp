// Vault-state-aware folder discovery.
//
// The whole point of routing logic living in the MCP (vs. the agent) is that
// the MCP can see what folders actually exist in the vault. This module
// fetches the live folder list from the CLI and ranks candidates against a
// topic key.
import { runObsidian } from "./exec.js";

export interface FolderMatch {
  folder: string;
  score: number;
  matchedTokens: string[];
}

/**
 * Lists every folder in the vault. Asks for `format=paths` because that gives
 * us one folder per line — robust regardless of CLI version's JSON shape.
 */
export async function listVaultFolders(vault?: string): Promise<string[]> {
  const result = await runObsidian("folders", { vault, format: "paths" });
  return result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""));
}

/** Tokenizes "recipe-chinese", "食譜/中式", "Inbox_2026" into atomic units. */
export function tokenize(s: string): string[] {
  return s
    .split(/[\s/\\\-_.]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Similarity score between a topic and a folder path. Returns 0..1. Combines:
 *   - exact equality (per token)
 *   - substring containment
 *   - shared-token ratio
 *
 * Folder depth is ignored intentionally: "Recipes/Chinese" and "Chinese"
 * should both score against topic "chinese-recipe".
 */
export function scoreSimilarity(
  topic: string,
  folder: string,
): { score: number; matchedTokens: string[] } {
  const tTokens = new Set(tokenize(topic));
  const fTokens = new Set(tokenize(folder));
  if (tTokens.size === 0 || fTokens.size === 0) {
    return { score: 0, matchedTokens: [] };
  }

  const matched: string[] = [];
  for (const t of tTokens) {
    if (fTokens.has(t)) {
      matched.push(t);
      continue;
    }
    // Substring match counts as half a hit.
    for (const f of fTokens) {
      if (f.includes(t) || t.includes(f)) {
        matched.push(t);
        break;
      }
    }
  }

  if (matched.length === 0) {
    // Last-ditch: full-string substring (handles CJK that doesn't tokenize).
    const tLow = topic.toLowerCase();
    const fLow = folder.toLowerCase();
    if (fLow.includes(tLow) || tLow.includes(fLow)) {
      return { score: 0.4, matchedTokens: [topic] };
    }
    return { score: 0, matchedTokens: [] };
  }

  // Jaccard-ish: matched / (topic-tokens + folder-tokens-not-matched)
  const denom = tTokens.size + Math.max(0, fTokens.size - matched.length);
  const score = matched.length / denom;
  return { score, matchedTokens: matched };
}

export async function findSimilarFolders(args: {
  topic: string;
  vault?: string;
  threshold?: number;
  limit?: number;
}): Promise<FolderMatch[]> {
  const { topic, vault, threshold = 0.25, limit = 5 } = args;
  const folders = await listVaultFolders(vault);
  const ranked = folders
    .map((folder) => ({ folder, ...scoreSimilarity(topic, folder) }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ranked;
}
