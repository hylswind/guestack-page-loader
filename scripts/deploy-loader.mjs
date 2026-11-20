// Deploys site/index.html to the loader's S3 bucket exactly as committed.
//
// The file is uploaded byte for byte; nothing is transformed, copied, or
// generated, and the CDN bucket is never touched. It is stored with
//
//   Cache-Control: public, max-age=0, s-maxage=<LOADER_EDGE_TTL>
//
// Cloudflare keeps it at the edge for LOADER_EDGE_TTL seconds (its Cache Rule
// respects the origin), while browsers revalidate it with Cloudflare on every
// visit. A deploy reaches visitors once the edge copy expires or is purged.
// CloudFront uses the CachingDisabled policy, so it needs no invalidation.
//
// Refuses to run when site/ has uncommitted or untracked changes.
//
// Usage: npm run deploy:loader [-- <extra aws s3 cp flags>]
// Env:   LOADER_BUCKET (required), AWS_PROFILE (optional; any standard AWS credentials work),
//        LOADER_EDGE_TTL (seconds, default 300)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
process.chdir(root);
if (existsSync(".env")) process.loadEnvFile(".env");

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

const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "site/index.html"], { encoding: "utf8" });
if (tracked.status !== 0) die("site/index.html must be committed.");

const bucket = process.env.LOADER_BUCKET;
if (!bucket) die("LOADER_BUCKET is not set (environment or .env).");

const edgeTtl = process.env.LOADER_EDGE_TTL || "300";
if (!/^[1-9][0-9]*$/.test(edgeTtl)) die(`LOADER_EDGE_TTL must be a positive number of seconds, got ${JSON.stringify(edgeTtl)}.`);

const indexHtml = readFileSync(join("site", "index.html"), "utf8");
const m = indexHtml.match(/const CDN_BASE_URL = "([^"]+)";/);
if (!m) die("could not find the CDN_BASE_URL literal in site/index.html.");

const args = [
  "s3", "cp", "site/index.html", `s3://${bucket}/index.html`,
  "--content-type", "text/html; charset=utf-8",
  "--cache-control", `public, max-age=0, s-maxage=${edgeTtl}`,
  ...process.argv.slice(2),
];
console.log(`deploy-loader: CDN_BASE_URL = ${m[1]}`);
console.log(`deploy-loader: aws ${args.join(" ")}`);

const run = spawnSync("aws", args, { stdio: "inherit" });
process.exit(run.status ?? 1);
