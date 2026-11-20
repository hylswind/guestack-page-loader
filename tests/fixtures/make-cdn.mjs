// Builds a CDN tree that follows docs/CDN-CONTRACT.md from the fixture pages.
//
//   <outDir>/blobs/<hex>.html            exact page bytes, <hex> = lowercase SHA-256 of those bytes
//   <outDir>/manifests/<YYYYMM>.json     { "version": 1, "pages": { "<name>": { "sha256": "<hex>" } } }
//
// One manifest is written for each requested UTC month (default: the current one).
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
export const MONTH_RE = /^[0-9]{6}$/;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The UTC month of `date` as "YYYYMM", the same key the loader computes. */
export function utcMonth(date = new Date()) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function makeCdn({
  pagesDir = DEFAULT_PAGES_DIR,
  outDir = DEFAULT_OUT_DIR,
  months = [utcMonth()],
} = {}) {
  for (const month of months) {
    if (!MONTH_RE.test(month)) throw new Error(`Invalid month: ${JSON.stringify(month)}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "blobs"), { recursive: true });
  mkdirSync(join(outDir, "manifests"), { recursive: true });

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
  const body = JSON.stringify(manifest, null, 2) + "\n";
  for (const month of months) {
    writeFileSync(join(outDir, "manifests", `${month}.json`), body);
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = makeCdn();
  console.log(`Wrote ${DEFAULT_OUT_DIR} (manifests/${utcMonth()}.json)`);
  console.log(JSON.stringify(manifest, null, 2));
}
