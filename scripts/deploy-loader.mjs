// Deploys site/ to Cloudflare Pages exactly as committed.
//
// This script does not transform, copy, or generate anything, and touches
// nothing on R2. It refuses to run when:
//   - site/ has uncommitted or untracked changes, or
//   - CDN_BASE_URL in site/index.html is still the temporary placeholder.
//
// Usage: npm run deploy:loader [-- <extra wrangler pages deploy flags>]
// Env:   PAGES_PROJECT (default "loader"), CLOUDFLARE_API_TOKEN (or `wrangler login`)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
process.chdir(root);
if (existsSync(".env")) process.loadEnvFile(".env");

// The temporary value committed before the real r2.dev URL is known.
const PLACEHOLDER_CDN_BASE_URL = "https://pub-00000000000000000000000000000000.r2.dev/";

function die(msg) {
  console.error(`deploy-loader: ${msg}`);
  process.exit(1);
}

const git = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "site/"], {
  encoding: "utf8",
});
if (git.status !== 0) die(`git status failed:\n${git.stderr}`);
if (git.stdout.trim() !== "") {
  die(`site/ has uncommitted changes. Commit them first; what is deployed must match git.\n${git.stdout}`);
}

const head = spawnSync("git", ["ls-files", "--error-unmatch", "site/index.html", "site/_headers"], {
  encoding: "utf8",
});
if (head.status !== 0) die("site/index.html and site/_headers must be committed.");

const indexHtml = readFileSync(join("site", "index.html"), "utf8");
const m = indexHtml.match(/const CDN_BASE_URL = "([^"]+)";/);
if (!m) die("could not find the CDN_BASE_URL literal in site/index.html.");
if (m[1] === PLACEHOLDER_CDN_BASE_URL) {
  die(
    "CDN_BASE_URL in site/index.html is still the temporary placeholder.\n" +
      "Set it to the bucket's real public URL (see README.md, Infrastructure setup) and commit.",
  );
}

const project = process.env.PAGES_PROJECT || "loader";
const args = ["wrangler", "pages", "deploy", "site", "--project-name", project, ...process.argv.slice(2)];
console.log(`deploy-loader: CDN_BASE_URL = ${m[1]}`);
console.log(`deploy-loader: npx ${args.join(" ")}`);

const run = spawnSync("npx", args, { stdio: "inherit" });
process.exit(run.status ?? 1);
