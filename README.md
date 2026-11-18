# Checksum Loader

A static loader on Cloudflare Pages that only loads pages whose SHA-256 checksum the browser has verified.

[Overview](#overview) • [Getting started](#getting-started) • [Deployment](#deployment) • [Infrastructure setup](#infrastructure-setup) • [Limitations](#limitations)

## Overview

Opening `https://<LOADER_HOST>/<page>`:

1. looks up the current SHA-256 of `<page>` in a single `manifest.json` on the CDN,
2. downloads `blobs/<sha256>.html` with [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Subresource_Integrity),
3. replaces the current document with that HTML once the browser has verified it.

```
/login ─▶ validate page name
       ─▶ fetch <CDN_BASE_URL>manifest.json        → pages.login.sha256 = <hex>
       ─▶ fetch <CDN_BASE_URL>blobs/<hex>.html     with integrity="sha256-…"
       ─▶ verified ─▶ document.write(html)

/      ─▶ show a notice, make no network requests
```

Unverified content is never loaded. If any step fails, the loader shows an error instead.

Pages are built and published by a separate app repository. The interface between the two is [`docs/CDN-CONTRACT.md`](docs/CDN-CONTRACT.md).

### Key features

- **No build step.** `site/` holds two hand-written files and is deployed byte for byte, so you can compare the served file with git directly.
- **No dependencies.** The loader is one HTML file with one inline script. It loads no external scripts, styles, fonts or images.
- **One setting.** The CDN location is a single literal in `site/index.html`.
- **Untrusted manifest.** The loader reads only `pages.<name>.sha256` from the manifest. The page name is validated before any request is made and is never used to build a URL.

### What visitors see

| Situation | Message |
| --- | --- |
| Loading (shown only if it takes longer than 0.35 s) | Loading… |
| `/` with no page name | No page specified. Please open the full link you were given. |
| Malformed page name (`/Login`, `/a/b`, `/login.html`) | Invalid page. |
| Manifest missing, not JSON, or has no `pages` object | Unable to look up the page. |
| Page not listed in the manifest | Page not found. |
| Checksum is not 64 lowercase hex characters | Invalid checksum. |
| Blob request returns a non-2xx status | Page content is unavailable. |
| Checksum mismatch, network or CORS failure | Failed to load the page. |
| JavaScript disabled | This page requires JavaScript. |

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or later (dev tooling only)
- A Cloudflare account, for deployment only

### Install and test

```sh
npm install
npx playwright install chromium

npm test            # unit tests: site/ contents, the CDN_BASE_URL literal, the fixture builder
npm run test:e2e    # Playwright against `wrangler pages dev site` on http://localhost:8788
```

To run a single test:

```sh
node --test --test-name-pattern="exactly one CDN_BASE_URL" tests/site.test.mjs
npx playwright test -g "tampered blob"
```

The E2E tests serve the unmodified `site/` directory. Every request to `CDN_BASE_URL` is answered from `tmp/test-cdn`, which is built from `tests/fixtures/pages/`. A request to any other host fails the test, so nothing reaches the real CDN.

> [!NOTE]
> Chromium does not enforce CORS on intercepted responses, so the E2E tests do not cover CORS. Check it against the real bucket with `curl` (see [Verify](#verify)).

### Local preview

```sh
npx wrangler pages dev site
```

Then open http://localhost:8788/login. This works only if the bucket's CORS policy allows `http://localhost:8788`.

## Configuration

The only setting is the `CDN_BASE_URL` literal in `site/index.html`. It must be on its own line, in exactly this form, with a trailing slash:

```js
  const CDN_BASE_URL = "https://pub-<id>.r2.dev/";
```

The tests and scripts parse this line, so keep it as a plain string literal.

The dev scripts read `.env`; copy it from [`.env.example`](.env.example):

| Variable | Used by | Purpose |
| --- | --- | --- |
| `PAGES_PROJECT` | `deploy:loader` | Cloudflare Pages project name (default `loader`) |
| `R2_BUCKET` | `seed:dev` | Bucket to upload test fixtures to |
| `CLOUDFLARE_API_TOKEN` | wrangler | Optional if you use `npx wrangler login` |

## Deployment

Commit your changes, then run:

```sh
npm run deploy:loader   # wrangler pages deploy site --project-name $PAGES_PROJECT
```

The script refuses to deploy if `site/` has uncommitted or untracked changes. It never transforms files and never touches R2.

> [!WARNING]
> Each of these breaks the loader:
>
> - Adding a top-level `404.html`. It disables the Pages SPA fallback that serves the loader on every path.
> - Adding `/* /index.html 200` to `_redirects`. Wrangler rejects it as an infinite loop.
> - Turning on a Cloudflare feature that rewrites HTML on `LOADER_HOST`, such as Rocket Loader, email obfuscation or automatic Web Analytics injection.

## Infrastructure setup

The setup uses an R2 bucket with its public `r2.dev` URL, a classic Cloudflare Pages project, and a CNAME at an external DNS provider. The examples use the bucket `loader-pages` and the project `loader`.

### Cloudflare

1. Create the bucket, enable its public development URL, and write that URL into `site/index.html` as `CDN_BASE_URL`:

   ```sh
   npx wrangler r2 bucket create loader-pages
   npx wrangler r2 bucket dev-url enable loader-pages
   npx wrangler r2 bucket dev-url get loader-pages    # https://pub-<id>.r2.dev
   ```

2. Create the Pages project and deploy. `project create` prints the `<PAGES_SUBDOMAIN>.pages.dev` address; the subdomain gets a suffix if the project name is already taken.

   ```sh
   npx wrangler pages project create loader --production-branch main
   npm run deploy:loader
   ```

3. Set the bucket's CORS policy:

   ```json
   {
     "rules": [
       {
         "allowed": {
           "origins": [
             "https://<LOADER_HOST>",
             "https://<PAGES_SUBDOMAIN>.pages.dev",
             "http://localhost:8788"
           ],
           "methods": ["GET", "HEAD"]
         },
         "maxAgeSeconds": 3600
       }
     ]
   }
   ```

   ```sh
   npx wrangler r2 bucket cors set loader-pages --file r2-cors.json
   ```

4. Optional, for a bucket with no real pages yet: upload the test fixtures.

   ```sh
   R2_BUCKET=loader-pages npm run seed:dev -- --yes-overwrite-manifest
   ```

   > [!CAUTION]
   > This overwrites `manifest.json`. Never run it against a bucket that serves real pages.

5. In the Pages project, go to **Custom domains** and add `LOADER_HOST`.

### DNS

6. At your DNS provider, create `LOADER_HOST CNAME <PAGES_SUBDOMAIN>.pages.dev` (TTL 300).

> [!IMPORTANT]
> Add the custom domain in Pages (step 5) before you create the CNAME. Without it, the CNAME returns error 522. If the zone has CAA records, they must allow the certificate authorities Cloudflare uses.

### Verify

```sh
# 200 with Cache-Control: no-cache
curl -I https://<LOADER_HOST>/login

# Byte identity: the two hashes must match
curl -s https://<LOADER_HOST>/ | sha256sum
sha256sum site/index.html

# CORS: both return 200, Access-Control-Allow-Origin, and the Cache-Control from the contract
curl -sI -H "Origin: https://<LOADER_HOST>" <CDN_BASE_URL>manifest.json
curl -sI -H "Origin: https://<LOADER_HOST>" <CDN_BASE_URL>blobs/<hex>.html
```

Then open `https://<LOADER_HOST>/login` in a browser.

## Project structure

```
site/
  index.html            the loader
  _headers              Cache-Control: no-cache and security headers for every path
docs/CDN-CONTRACT.md    contract for the app repository that publishes pages
scripts/
  deploy-loader.mjs     deploys site/ to Pages after safety checks
  seed-dev.mjs          uploads the test fixtures to a dev bucket
tests/
  site.test.mjs         unit tests
  e2e.spec.mjs          Playwright tests
  fixtures/             sample pages and make-cdn.mjs, the reference publisher
```

## Limitations

- **r2.dev is not for production.** It has no edge cache, so every request is a billed R2 read. It is also rate limited and may throttle bandwidth. Low-traffic use stays well inside the R2 free tier.
- **The bucket is the trust boundary.** Anyone with write access to the bucket controls what loads. Signing the manifest would remove the CDN from the trust boundary; the loader would verify it with an embedded public key through WebCrypto.
- **There is one publisher.** The shared manifest assumes a single writer. With more than one, use one pointer file per page.
- **Pages are not isolated.** All pages share one origin, and there is no CSP.

### Before production traffic

Put the bucket behind its own cached hostname:

1. Attach a custom domain (`CDN_HOST`) to the bucket.
2. Add a Cache Rule so `CDN_HOST` is eligible for cache and respects the origin's `Cache-Control`.
3. Add a response-header Transform Rule that always sets `Access-Control-Allow-Origin: *` and `X-Content-Type-Options: nosniff`. Without it, the cache can replay a response that was stored without CORS headers.
4. Change `CDN_BASE_URL` to `https://<CDN_HOST>/`, commit, redeploy, and run the byte-identity check again.
5. Disable the `r2.dev` URL.

To verify, request `manifest.json` and a blob twice each. The second response should show `cf-cache-status: HIT` and `Access-Control-Allow-Origin`.

With caching, a manifest change becomes visible within the manifest TTL. R2 then serves at most one manifest read per TTL per edge location: at a 60-second TTL, that is 43,200 reads per month per edge location with traffic. Blobs are immutable and cached for a year.
