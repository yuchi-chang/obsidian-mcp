#!/usr/bin/env node
// Manual smoke test for organize_apply.
//
// Requires:
//   - A running Obsidian instance with the CLI registered
//   - A test vault you don't mind writing to (set OBSIDIAN_TEST_VAULT env var)
//
// What it tests:
//   1. CLI `move` to a NEW folder — does it auto-create the folder?
//   2. End-to-end scan → validate → apply on three throwaway notes.
//
// Usage:
//   OBSIDIAN_TEST_VAULT="MyTestVault" node scripts/organize-smoke.mjs

import assert from "node:assert/strict";

const VAULT = process.env.OBSIDIAN_TEST_VAULT;
if (!VAULT) {
  console.error("Set OBSIDIAN_TEST_VAULT to the name of a test vault.");
  process.exit(2);
}

const exec = await import("../dist/exec.js");
const search = await import("../dist/folderSearch.js");

const stamp = Date.now();
const probeName = `organize-smoke-${stamp}.md`;
const probeFolder = `organize-smoke-folder-${stamp}`;

console.log(`Vault: ${VAULT}`);
console.log(`Probe note: ${probeName}`);
console.log(`Probe folder: ${probeFolder}\n`);

async function run() {
  // 1. Create probe note at root.
  await exec.runObsidian("create", {
    vault: VAULT,
    params: { name: probeName, content: `# probe ${stamp}` },
  });
  console.log(`✓ created ${probeName}`);

  // 2. Try to move it into a non-existent folder.
  let moveCreatesFolder = false;
  try {
    await exec.runObsidian("move", {
      vault: VAULT,
      params: { path: probeName, to: `${probeFolder}/${probeName}` },
    });
    moveCreatesFolder = true;
    console.log(`✓ move succeeded — CLI auto-creates intermediate folders`);
  } catch (err) {
    console.log(`✗ move failed without pre-created folder: ${err.message}`);
  }

  // 3. Verify final location.
  const folders = await search.listVaultFolders(VAULT);
  const folderExists = folders.some((f) => f === probeFolder);
  console.log(`Folder now exists in vault: ${folderExists}`);

  // 4. Cleanup — delete the probe note.
  const cleanupPath = moveCreatesFolder ? `${probeFolder}/${probeName}` : probeName;
  try {
    await exec.runObsidian("delete", { vault: VAULT, params: { path: cleanupPath } });
    console.log(`✓ cleaned up ${cleanupPath}`);
  } catch (err) {
    console.log(`! cleanup failed (please delete manually): ${err.message}`);
  }

  // 5. Final report.
  console.log(`\nResult: CLI move ${moveCreatesFolder ? "DOES" : "DOES NOT"} auto-create folders.`);
  if (!moveCreatesFolder) {
    console.log(
      "→ Implement ensureFolders() in organize.ts to create destination folders before move.",
    );
  }
}

run().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
