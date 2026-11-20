// End-to-end tests for site/index.html.
//
// site/ is served unmodified by `wrangler pages dev` (see playwright.config.mjs).
// The CDN is never contacted: CDN_BASE_URL is read out of site/index.html and
// every request to its origin is answered from tmp/test-cdn by page.route().
// Any request to a host other than the local dev server fails the test.

import { expect, test } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_OUT_DIR } from "./fixtures/make-cdn.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const indexHtml = readFileSync(join(root, "site/index.html"), "utf8");
const CDN_BASE_URL = indexHtml.match(/const CDN_BASE_URL = "([^"]+)";/)[1];
const CDN_ORIGIN = new URL(CDN_BASE_URL).origin;

// Built once by tests/global-setup.mjs; workers only read it. The fake CDN
// serves this manifest for every month unless a test overrides it.
const [MANIFEST_FILE] = readdirSync(join(DEFAULT_OUT_DIR, "manifests"));
const MANIFEST = JSON.parse(readFileSync(join(DEFAULT_OUT_DIR, "manifests", MANIFEST_FILE), "utf8"));
const LOGIN_HEX = MANIFEST.pages.login.sha256;
const HOME_HEX = MANIFEST.pages.home.sha256;
const manifestBody = (manifest) => JSON.stringify(manifest);
const blobBody = (hex) => readFileSync(join(DEFAULT_OUT_DIR, "blobs", `${hex}.html`));

const CORS = { "Access-Control-Allow-Origin": "*" };

// Every test runs with a fixed clock (UTC), so the loader asks for this month.
const NOW = new Date("2026-11-15T12:00:00Z");
const MONTH = "202611";
const MANIFEST_PATH = `manifests/${MONTH}.json`;

/**
 * Installs the fake CDN for one test.
 *
 * Overrides (all optional), each a function returning a route.fulfill() option
 * object, or undefined for the default behaviour:
 *   manifest(month)   response for manifests/<month>.json
 *   blob(hex)         response for blobs/<hex>.html
 *
 * Returns { requests, unexpected, set } where requests lists every CDN path
 * requested and unexpected lists every request that should never happen.
 */
async function fakeCdn(page, overrides = {}) {
  const state = { requests: [], unexpected: [], overrides };

  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());

    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return route.continue();
    }
    if (url.origin !== CDN_ORIGIN) {
      state.unexpected.push(url.href);
      return route.abort();
    }

    const path = url.pathname.slice(new URL(CDN_BASE_URL).pathname.length);
    state.requests.push(path);

    const manifest = path.match(/^manifests\/([0-9]{6})\.json$/);
    if (manifest) {
      const custom = state.overrides.manifest?.(manifest[1]);
      return route.fulfill(
        custom ?? {
          status: 200,
          headers: { ...CORS, "Content-Type": "application/json" },
          body: manifestBody(MANIFEST),
        },
      );
    }

    const blob = path.match(/^blobs\/([0-9a-f]{64})\.html$/);
    if (blob) {
      const hex = blob[1];
      const custom = state.overrides.blob?.(hex);
      if (custom) return route.fulfill(custom);
      let body;
      try {
        body = blobBody(hex);
      } catch {
        return route.fulfill({ status: 404, headers: CORS, body: "not found" });
      }
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" },
        body,
      });
    }

    state.unexpected.push(url.href);
    return route.abort();
  });

  state.set = (next) => Object.assign(state.overrides, next);
  return state;
}

/** Waits until the loader has finished: a notice, an error, or a loaded page. */
async function settled(page) {
  await page.waitForFunction(
    () =>
      document.querySelector("#status.notice, #status.error") ||
      document.querySelector("#script-ran"),
  );
}

/** The <noscript> fallback must never be visible while scripting is on. */
async function expectNoNoscriptText(page) {
  const visible = await page.locator("body").innerText();
  expect(visible).not.toContain("requires JavaScript");
  expect(visible).not.toContain("<style>");
}

async function expectError(page, text) {
  await settled(page);
  await expectNoNoscriptText(page);
  const status = page.locator("#status");
  await expect(status).toHaveClass("error");
  if (text) await expect(status).toHaveText(text);
  await expect(page.locator("#script-ran")).toHaveCount(0);
}

async function expectNotice(page) {
  await settled(page);
  await expectNoNoscriptText(page);
  const status = page.locator("#status");
  await expect(status).toHaveClass("notice");
  await expect(status).toHaveText("No page specified. Please open the full link you were given.");
}

let dialogs;
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  dialogs = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });
});

test.afterEach(async () => {
  expect(dialogs, "no script injection (no dialogs)").toEqual([]);
});

test.describe("noscript fallback", () => {
  test("with JavaScript disabled, only the fallback message is shown", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("/?page=login");
    await expect(page.locator(".noscript")).toBeVisible();
    await expect(page.locator(".noscript")).toHaveText("This page requires JavaScript.");
    await expect(page.locator("#status")).toBeHidden();
    await ctx.close();
  });
});

test.describe("dev server", () => {
  test("serves the unmodified loader at / and /index.html", async ({ request }) => {
    for (const path of ["/", "/?page=login", "/index.html"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(await res.text(), path).toBe(indexHtml);
    }
  });
});

test.describe("loading pages", () => {
  for (const path of ["/?page=login", "/index.html?page=login", "/?page=login&page=home"]) {
    test(`${path} shows the login page and runs its script`, async ({ page }) => {
      const cdn = await fakeCdn(page);
      await page.goto(path);
      await expect(page.locator("#script-ran")).toHaveText("login script ran");
      await expect(page.locator("#title")).toHaveText("Login fixture page");
      expect(cdn.requests).toEqual([MANIFEST_PATH, `blobs/${LOGIN_HEX}.html`]);
      expect(cdn.unexpected).toEqual([]);
    });
  }

  test("query string and hash survive and are readable by the page", async ({ page }) => {
    const cdn = await fakeCdn(page);
    await page.goto("/?page=login&foo=1#bar");
    await expect(page.locator("#script-ran")).toHaveText("login script ran");
    await expect(page.locator("#search")).toHaveText("?page=login&foo=1");
    await expect(page.locator("#hash")).toHaveText("#bar");
    expect(new URL(page.url()).pathname).toBe("/");
    expect(cdn.unexpected).toEqual([]);
  });

  test("changing the manifest entry changes what loads, loader untouched", async ({ page }) => {
    const cdn = await fakeCdn(page);
    await page.goto("/?page=login");
    await expect(page.locator("#title")).toHaveText("Login fixture page");

    const changed = structuredClone(MANIFEST);
    changed.pages.login.sha256 = HOME_HEX;
    cdn.set({
      manifest: () => ({
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
        body: manifestBody(changed),
      }),
    });

    await page.goto("/?page=login");
    await expect(page.locator("#title")).toHaveText("Home fixture page");
    await expect(page.locator("#script-ran")).toHaveText("home script ran");
    expect(cdn.requests.at(-1)).toBe(`blobs/${HOME_HEX}.html`);
    expect(cdn.unexpected).toEqual([]);
  });
});

test.describe("no page name", () => {
  for (const path of ["/", "/?page=", "/?foo=1", "/login"]) {
    test(`${path} shows the notice and makes no CDN request`, async ({ page }) => {
      const cdn = await fakeCdn(page);
      await page.goto(path);
      await expectNotice(page);
      await page.waitForLoadState("networkidle");
      expect(cdn.requests).toEqual([]);
      expect(cdn.unexpected).toEqual([]);
    });
  }
});

test.describe("invalid page names", () => {
  for (const path of [
    "/?page=a/b",
    "/?page=Login",
    "/?page=__proto__",
    "/?page=%3Cscript%3E",
    "/?page=login.html",
    "/?page=%20login",
  ]) {
    test(`${path} is rejected without any CDN request`, async ({ page }) => {
      const cdn = await fakeCdn(page);
      await page.goto(path);
      await expectError(page, "Invalid page.");
      await page.waitForLoadState("networkidle");
      expect(await page.locator("script").count()).toBe(1);
      expect(cdn.requests).toEqual([]);
      expect(cdn.unexpected).toEqual([]);
    });
  }
});

test.describe("manifest problems", () => {
  test("page missing from the manifest: Page not found, no blob request", async ({ page }) => {
    const cdn = await fakeCdn(page);
    await page.goto("/?page=nope");
    await expectError(page, "Page not found.");
    expect(cdn.requests).toEqual([MANIFEST_PATH]);
  });

  const json = (body) => () => ({
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
    body,
  });
  const cases = {
    "malformed JSON": [json("{ not json"), "Unable to look up the page."],
    "JSON null": [json("null"), "Unable to look up the page."],
    "no pages object": [json(JSON.stringify({ version: 1 })), "Unable to look up the page."],
    "pages is an array": [json(JSON.stringify({ pages: [] })), "Unable to look up the page."],
    "non-hex sha256": [
      json(JSON.stringify({ pages: { login: { sha256: "Z".repeat(64) } } })),
      "Invalid checksum.",
    ],
    "uppercase sha256": [
      json(JSON.stringify({ pages: { login: { sha256: LOGIN_HEX.toUpperCase() } } })),
      "Invalid checksum.",
    ],
    "path traversal in sha256": [
      json(JSON.stringify({ pages: { login: { sha256: "../manifest" } } })),
      "Invalid checksum.",
    ],
    "entry is not an object": [
      json(JSON.stringify({ pages: { login: LOGIN_HEX } })),
      "Invalid checksum.",
    ],
    "404": [() => ({ status: 404, headers: CORS, body: "not found" }), "Unable to look up the page."],
    "500": [() => ({ status: 500, headers: CORS, body: "error" }), "Unable to look up the page."],
  };
  for (const [name, [manifest, message]] of Object.entries(cases)) {
    test(`manifest ${name}: error shown, no blob request`, async ({ page }) => {
      const cdn = await fakeCdn(page, { manifest });
      await page.goto("/?page=login");
      await expectError(page, message);
      expect(cdn.requests).toEqual([MANIFEST_PATH]);
      expect(cdn.unexpected).toEqual([]);
    });
  }

  test("inherited keys such as constructor are not pages", async ({ page }) => {
    const cdn = await fakeCdn(page);
    await page.goto("/?page=constructor");
    await expectError(page, "Page not found.");
    expect(cdn.requests).toEqual([MANIFEST_PATH]);
  });
});

test.describe("blob problems", () => {
  test("tampered blob is refused and never written", async ({ page }) => {
    const tampered = blobBody(LOGIN_HEX)
      .toString("utf8")
      .replace("login script ran", "TAMPERED script ran")
      .replace("<script>", "<script>alert('tampered');");
    const cdn = await fakeCdn(page, {
      blob: () => ({
        status: 200,
        headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" },
        body: tampered,
      }),
    });
    await page.goto("/?page=login");
    await expectError(page, "Failed to load the page.");
    expect(await page.content()).not.toContain("TAMPERED");
    expect(cdn.requests).toEqual([MANIFEST_PATH, `blobs/${LOGIN_HEX}.html`]);
  });

  test("a single appended byte is refused", async ({ page }) => {
    await fakeCdn(page, {
      blob: (hex) => ({
        status: 200,
        headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" },
        body: Buffer.concat([blobBody(hex), Buffer.from(" ")]),
      }),
    });
    await page.goto("/?page=login");
    await expectError(page, "Failed to load the page.");
  });

  test("blob 404: error shown", async ({ page }) => {
    await fakeCdn(page, { blob: () => ({ status: 404, headers: CORS, body: "not found" }) });
    await page.goto("/?page=login");
    // The integrity check also runs on the 404 body, so fetch() rejects
    // before res.ok is checked. Either way the page is not loaded.
    await expectError(page);
    await expect(page.locator("#title")).toHaveCount(0);
  });
});

test.describe("monthly manifest", () => {
  const boundaries = {
    "2026-11-30T23:59:59.999Z": "202611",
    "2026-12-01T00:00:00.000Z": "202612",
    "2026-12-31T23:59:59.999Z": "202612",
    "2027-01-01T00:00:00.000Z": "202701",
  };
  for (const [iso, month] of Object.entries(boundaries)) {
    test(`at ${iso} the loader reads manifests/${month}.json`, async ({ page }) => {
      await page.clock.setFixedTime(new Date(iso));
      const cdn = await fakeCdn(page);
      await page.goto("/?page=login");
      await expect(page.locator("#script-ran")).toHaveText("login script ran");
      expect(cdn.requests[0]).toBe(`manifests/${month}.json`);
      expect(cdn.unexpected).toEqual([]);
    });
  }

  test("the month is UTC, not the visitor's local time zone", async ({ browser }) => {
    const ctx = await browser.newContext({ timezoneId: "Asia/Taipei" });
    const page = await ctx.newPage();
    // 1 December 00:30 in Taipei, still November in UTC.
    await page.clock.setFixedTime(new Date("2026-11-30T16:30:00Z"));
    const cdn = await fakeCdn(page);
    await page.goto("/?page=login");
    await expect(page.locator("#script-ran")).toHaveText("login script ran");
    expect(await page.evaluate(() => new Date().getDate())).toBe(1);
    expect(cdn.requests[0]).toBe("manifests/202611.json");
    await ctx.close();
  });

  test("pages published for next month take over when it starts", async ({ page }) => {
    const december = structuredClone(MANIFEST);
    december.pages.login.sha256 = HOME_HEX;
    const cdn = await fakeCdn(page, {
      manifest: (month) =>
        month === "202612"
          ? {
              status: 200,
              headers: { ...CORS, "Content-Type": "application/json" },
              body: manifestBody(december),
            }
          : undefined,
    });

    await page.goto("/?page=login");
    await expect(page.locator("#title")).toHaveText("Login fixture page");

    await page.clock.setFixedTime(new Date("2026-12-01T00:00:00Z"));
    await page.goto("/?page=login");
    await expect(page.locator("#title")).toHaveText("Home fixture page");
    expect(cdn.requests).toEqual([
      "manifests/202611.json",
      `blobs/${LOGIN_HEX}.html`,
      "manifests/202612.json",
      `blobs/${HOME_HEX}.html`,
    ]);
  });

  test("a missing month manifest is an error, with no fallback to another month", async ({ page }) => {
    const cdn = await fakeCdn(page, {
      manifest: (month) =>
        month === MONTH ? { status: 404, headers: CORS, body: "not found" } : undefined,
    });
    await page.goto("/?page=login");
    await expectError(page, "Unable to look up the page.");
    await page.waitForLoadState("networkidle");
    expect(cdn.requests).toEqual([MANIFEST_PATH]);
  });
});

// No CORS scenario: Chromium does not enforce CORS on responses fulfilled by
// page.route(), so a missing Access-Control-Allow-Origin header cannot be
// simulated here. Instead, CORS is verified against the real
// bucket with the curl checks in README.md ("Verify").
