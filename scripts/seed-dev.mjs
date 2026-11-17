// DEV ONLY. Uploads the test fixture pages to an empty development R2 bucket.
//
// It is NOT a publish tool: it OVERWRITES manifest.json with a manifest that
// only lists the fixture pages. Real pages are published by the app repository.
//
// Upload order follows docs/CDN-CONTRACT.md: all blobs first, manifest last.
//
// Usage: npm run seed:dev -- --yes-overwrite-manifest
// Env:   R2_BUCKET (required), CLOUDFLARE_API_TOKEN (or `wrangler login`)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_OUT_DIR, makeCdn } from "../tests/fixtures/make-cdn.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../..");
process.chdir(root);
if (existsSync(".env")) process.loadEnvFile(".env");

const WARNING =
  "WARNING: seed-dev is for an EMPTY DEVELOPMENT bucket only. It overwrites manifest.json\n" +
  "with a manifest listing only the test fixtures. Never run it against a bucket with real pages.";

console.warn(WARNING);

if (!process.argv.includes("--yes-overwrite-manifest")) {
  console.error("\nseed-dev: refusing to run without --yes-overwrite-manifest.");
  process.exit(1);
}

const bucket = process.env.R2_BUCKET;
if (!bucket) {
  console.error("seed-dev: R2_BUCKET is not set (environment or .env).");
  process.exit(1);
}

const BLOB_HEADERS = ["--content-type", "text/html; charset=utf-8", "--cache-control", "public, max-age=31536000, immutable"];
const MANIFEST_HEADERS = ["--content-type", "application/json", "--cache-control", "public, max-age=60"];

function put(key, file, headers) {
  const args = ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", file, ...headers, "--remote"];
  console.log(`seed-dev: npx ${args.join(" ")}`);
  const run = spawnSync("npx", args, { stdio: "inherit" });
  if (run.status !== 0) {
    console.error(`seed-dev: upload of ${key} failed; stopping (manifest not updated).`);
    process.exit(run.status ?? 1);
  }
}

const manifest = makeCdn();
for (const { sha256 } of Object.values(manifest.pages)) {
  put(`blobs/${sha256}.html`, join(DEFAULT_OUT_DIR, "blobs", `${sha256}.html`), BLOB_HEADERS);
}
put("manifest.json", join(DEFAULT_OUT_DIR, "manifest.json"), MANIFEST_HEADERS);

console.log(`seed-dev: done. Pages: ${Object.keys(manifest.pages).join(", ")}`);
