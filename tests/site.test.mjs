import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_PAGES_DIR, makeCdn, sha256Hex } from "./fixtures/make-cdn.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const siteDir = join(root, "site");
const indexHtml = readFileSync(join(siteDir, "index.html"), "utf8");

describe("site/", () => {
  test("contains exactly index.html and _headers", () => {
    assert.deepEqual(readdirSync(siteDir).sort(), ["_headers", "index.html"]);
  });

  test("_headers sets no-cache and the security headers for every path", () => {
    const headers = readFileSync(join(siteDir, "_headers"), "utf8");
    assert.match(headers, /^\/\*$/m);
    assert.match(headers, /^\s+Cache-Control: no-cache$/m);
    assert.match(headers, /^\s+X-Content-Type-Options: nosniff$/m);
    assert.match(headers, /^\s+Referrer-Policy: strict-origin-when-cross-origin$/m);
  });
});

describe("site/index.html", () => {
  test("declares exactly one CDN_BASE_URL string literal", () => {
    const decls = [...indexHtml.matchAll(/CDN_BASE_URL\s*=\s*(["'`])(.*?)\1/g)];
    assert.equal(decls.length, 1, "expected exactly one CDN_BASE_URL declaration");

    const url = decls[0][2];
    assert.match(url, /^https:\/\//, "must be an https:// URL");
    assert.ok(url.endsWith("/"), "must end with /");
    for (const bad of ["<", ">", "__", "${"]) {
      assert.ok(!url.includes(bad), `must not contain placeholder characters (${bad})`);
    }
    assert.doesNotThrow(() => new URL(url));

    // The literal is on its own line.
    const lines = indexHtml.split("\n").filter((l) => l.includes(url));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\s*const CDN_BASE_URL = "[^"]+";\s*$/);
  });

  test("references no external resources", () => {
    assert.doesNotMatch(indexHtml, /\bsrc\s*=/i, "no src=");
    assert.doesNotMatch(indexHtml, /\bhref\s*=/i, "no href=");
    assert.doesNotMatch(indexHtml, /\bimport\b/, "no import");
    assert.doesNotMatch(indexHtml, /<link\b/i, "no <link>");
    assert.doesNotMatch(indexHtml, /url\(/i, "no CSS url()");
  });

  test("has exactly one inline script and never uses innerHTML", () => {
    assert.equal(indexHtml.match(/<script\b/gi).length, 1);
    assert.doesNotMatch(indexHtml, /innerHTML|outerHTML|insertAdjacentHTML/);
  });
});

describe("tests/fixtures/make-cdn.mjs", () => {
  test("writes content-addressed blobs and a matching manifest", () => {
    const outDir = mkdtempSync(join(tmpdir(), "loader-cdn-"));
    try {
      const manifest = makeCdn({ outDir });

      const fixtures = readdirSync(DEFAULT_PAGES_DIR).filter((f) => f.endsWith(".html")).sort();
      const expectedPages = Object.fromEntries(
        fixtures.map((f) => [
          f.replace(/\.html$/, ""),
          { sha256: sha256Hex(readFileSync(join(DEFAULT_PAGES_DIR, f))) },
        ]),
      );
      assert.deepEqual(manifest, { version: 1, pages: expectedPages });

      const onDisk = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
      assert.deepEqual(onDisk, manifest);

      const blobs = readdirSync(join(outDir, "blobs")).sort();
      assert.equal(blobs.length, fixtures.length);
      for (const blob of blobs) {
        const hex = blob.replace(/\.html$/, "");
        assert.match(hex, /^[0-9a-f]{64}$/);
        assert.equal(sha256Hex(readFileSync(join(outDir, "blobs", blob))), hex);
      }
      assert.deepEqual(
        Object.values(manifest.pages).map((p) => `${p.sha256}.html`).sort(),
        blobs,
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
