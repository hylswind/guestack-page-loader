// Builds a CDN tree that follows docs/CDN-CONTRACT.md from the fixture pages.
//
//   <outDir>/blobs/<hex>.html   exact page bytes, <hex> = lowercase SHA-256 of those bytes
//   <outDir>/manifest.json      { "version": 1, "pages": { "<name>": { "sha256": "<hex>" } } }
//
// Used by the tests and by scripts/seed-dev.mjs. It is also the reference
// implementation of the contract for the app repository that publishes pages.
//
// Run directly:  node tests/fixtures/make-cdn.mjs

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

export const DEFAULT_PAGES_DIR = join(here, "pages");
export const DEFAULT_OUT_DIR = join(root, "tmp/test-cdn");

export const PAGE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function makeCdn({ pagesDir = DEFAULT_PAGES_DIR, outDir = DEFAULT_OUT_DIR } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "blobs"), { recursive: true });

  const pages = {};
  const files = readdirSync(pagesDir).filter((f) => f.endsWith(".html")).sort();
  for (const file of files) {
    const name = basename(file, ".html");
    if (!PAGE_NAME_RE.test(name) || name === "index") {
      throw new Error(`Invalid page name: ${JSON.stringify(name)}`);
    }
    // Hash the raw bytes. No decoding, no newline normalization.
    const bytes = readFileSync(join(pagesDir, file));
    const hex = sha256Hex(bytes);
    writeFileSync(join(outDir, "blobs", `${hex}.html`), bytes);
    pages[name] = { sha256: hex };
  }

  const manifest = { version: 1, pages };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = makeCdn();
  console.log(`Wrote ${DEFAULT_OUT_DIR}`);
  console.log(JSON.stringify(manifest, null, 2));
}
