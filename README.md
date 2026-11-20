# Checksum Loader

A single-file static loader that only loads pages whose SHA-256 checksum the browser has verified.

[Overview](#overview) • [Getting started](#getting-started) • [Deployment](#deployment) • [Infrastructure setup](#infrastructure-setup) • [Limitations](#limitations) • [Code transparency](#planned-code-transparency)

## Overview

Opening `https://<LOADER_HOST>/?page=<page>`:

1. looks up the SHA-256 of `<page>` in the current month's manifest on the CDN, `manifests/<YYYYMM>.json`,
2. downloads `blobs/<sha256>.html` with `fetch()` and its [`integrity`](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit#integrity) option (Subresource Integrity), so the browser rejects the response if its hash does not match,
3. replaces the current document with that HTML once the browser has verified it.

```
/?page=login ─▶ validate page name
             ─▶ fetch <CDN_BASE_URL>manifests/202611.json → pages.login.sha256 = <hex>
             ─▶ fetch <CDN_BASE_URL>blobs/<hex>.html     with integrity="sha256-…"
             ─▶ verified ─▶ document.write(html)

/            ─▶ show a notice, make no network requests
```

Unverified content is never loaded. If any step fails, the loader shows an error instead.

Pages are built and published by a separate app repository. The interface between the two is [`docs/CDN-CONTRACT.md`](docs/CDN-CONTRACT.md).

### Architecture

```
<LOADER_HOST> ─▶ Cloudflare (proxied, cached) ─▶ CloudFront ─▶ S3 (private)   index.html
<CDN_HOST>    ─▶ Cloudflare (proxied, cached) ─▶ R2                           manifests/, blobs/
```

### Key features

- **No build step.** `site/` holds one hand-written file, `index.html`, which is deployed byte for byte. You can compare the served file with git directly.
- **No dependencies.** The loader is one HTML file with one inline script. It loads no external scripts, styles, fonts or images.
- **One setting.** The CDN location is a single literal in `site/index.html`.
- **Scheduled releases.** Each UTC month has its own manifest. A month's pages can be published in advance, and every visitor switches to them at 00:00 UTC on the 1st.
- **Untrusted manifest.** The loader reads only `pages.<name>.sha256` from the manifest. The page name is validated before any request is made and is never used to build a URL.

### What visitors see

| Situation | Message |
| --- | --- |
| Loading (shown only if it takes longer than 0.35 s) | Loading… |
| No `page` parameter, or an empty one | No page specified. Please open the full link you were given. |
| Malformed page name (`?page=Login`, `?page=a/b`, `?page=login.html`) | Invalid page. |
| This month's manifest missing, not JSON, or has no `pages` object | Unable to look up the page. |
| Page not listed in the manifest | Page not found. |
| Checksum is not 64 lowercase hex characters | Invalid checksum. |
| Blob request returns a non-2xx status | Page content is unavailable. |
| Checksum mismatch, network or CORS failure | Failed to load the page. |
| JavaScript disabled | This page requires JavaScript. |

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or later (dev tooling only)
- For deployment and setup:
  - the [AWS CLI](https://aws.amazon.com/cli/), with access to the loader's S3 bucket;
  - a Cloudflare account that holds the DNS zone and the R2 bucket.

### Install and test

```sh
npm install
npx playwright install chromium

npm test            # unit tests: site/ contents, CDN_BASE_URL, the fixture builder
npm run test:e2e    # Playwright against `wrangler pages dev site` on http://localhost:8788
```

To run a single test:

```sh
node --test --test-name-pattern="exactly one CDN_BASE_URL" tests/site.test.mjs
npx playwright test -g "tampered blob"
```

The E2E tests serve the unmodified `site/` directory. Every request to `CDN_BASE_URL` is answered from `tmp/test-cdn`, which is built from `tests/fixtures/pages/`. A request to any other host fails the test, so nothing reaches the real CDN.

> [!NOTE]
> Chromium does not enforce CORS on intercepted responses, so the E2E tests do not cover CORS. Check it against the real CDN with `curl` (see [Verify](#verify)).

### Local preview

```sh
npx wrangler pages dev site
```

Then open http://localhost:8788/?page=login. This works only if the bucket's CORS policy allows `http://localhost:8788`.

## Configuration

The only setting is the `CDN_BASE_URL` literal in `site/index.html`. It must be on its own line, in exactly this form, with a trailing slash:

```js
  const CDN_BASE_URL = "https://<CDN_HOST>/";
```

The tests and scripts parse this line, so keep it as a plain string literal.

The dev scripts read `.env`; copy it from [`.env.example`](.env.example):

| Variable | Used by | Purpose |
| --- | --- | --- |
| `LOADER_BUCKET` | `deploy:loader` | S3 bucket that holds `index.html` |
| `AWS_PROFILE` | `deploy:loader` | Optional named AWS profile |
| `LOADER_EDGE_TTL` | `deploy:loader` | Seconds Cloudflare keeps the loader at the edge (default `300`; `31536000` in production) |
| `R2_BUCKET` | `seed:dev` | R2 bucket to upload the test fixtures to |
| `CLOUDFLARE_ACCOUNT_ID` | wrangler | Account that owns the R2 bucket and the zone |
| `CLOUDFLARE_API_TOKEN` | wrangler | Optional if you use `npx wrangler login` |

## Deployment

Commit your changes, then run:

```sh
npm run deploy:loader   # aws s3 cp site/index.html s3://$LOADER_BUCKET/index.html
```

The script refuses to deploy if `site/` has uncommitted or untracked changes. It uploads the file unchanged and never touches the CDN. The object is stored with:

- `Content-Type: text/html; charset=utf-8`;
- `Cache-Control: public, max-age=0, s-maxage=<LOADER_EDGE_TTL>`.

Cloudflare keeps the loader at the edge for `LOADER_EDGE_TTL` seconds, and browsers revalidate it with Cloudflare on every visit. CloudFront and S3 are only reached when the edge copy has expired. CloudFront itself does not cache the loader.

A deploy reaches visitors when the edge copy expires: within 5 minutes at the default TTL. With a long TTL, purge the cache after each deploy (Cloudflare dashboard → **Caching** → **Configuration** → **Custom Purge** → **Hostname** `<LOADER_HOST>`).

> [!WARNING]
> Each of these breaks the loader:
>
> - Setting Cloudflare SSL/TLS to Flexible for `<LOADER_HOST>`. CloudFront redirects HTTP to HTTPS, so requests loop.
> - Turning on a Cloudflare feature that rewrites HTML on `<LOADER_HOST>`, such as Rocket Loader, Email Obfuscation or automatic Web Analytics injection.

## Infrastructure setup

### AWS: loader

1. Create a private S3 bucket (`<LOADER_BUCKET>`) with Block Public Access on.
2. In **us-east-1**, request an ACM certificate for `<LOADER_HOST>`. Validate it with the CNAME that ACM gives you, added in Cloudflare as **DNS only**.
3. Create a CloudFront distribution:

   | Setting | Value |
   | --- | --- |
   | Origin | `<LOADER_BUCKET>` with Origin Access Control; add the bucket policy CloudFront offers |
   | Default root object | `index.html` |
   | Alternate domain name | `<LOADER_HOST>`, with the certificate from step 2 |
   | Viewer protocol policy | Redirect HTTP to HTTPS |
   | Cache policy | `CachingDisabled` (managed) |

4. Run `npm run deploy:loader`.

### Cloudflare: loader

5. Add a **proxied** `CNAME <LOADER_HOST> → <DISTRIBUTION>.cloudfront.net`.
6. Set SSL/TLS to **Full (strict)** for `<LOADER_HOST>`, and keep the HTML-rewriting features listed under [Deployment](#deployment) off.
7. Add a **Cache Rule** for hostname `<LOADER_HOST>`: eligible for cache, with Edge TTL and Browser TTL both respecting the origin.

### Cloudflare: CDN

These steps run in the Cloudflare account that holds the `<CDN_HOST>` zone. An R2 custom domain requires the bucket and the zone to be in the same account.

8. Create the bucket and connect `<CDN_HOST>` to it:

   ```sh
   npx wrangler r2 bucket create <R2_BUCKET>
   npx wrangler r2 bucket domain add <R2_BUCKET> --domain <CDN_HOST> --zone-id <ZONE_ID>
   ```

9. Set the bucket's CORS policy:

   ```json
   {
     "rules": [
       {
         "allowed": {
           "origins": ["https://<LOADER_HOST>", "http://localhost:8788"],
           "methods": ["GET", "HEAD"]
         },
         "maxAgeSeconds": 3600
       }
     ]
   }
   ```

   ```sh
   npx wrangler r2 bucket cors set <R2_BUCKET> --file r2-cors.json
   ```

10. Add a **Cache Rule** for hostname `<CDN_HOST>`: eligible for cache, with edge TTL taken from the origin's `Cache-Control`.
11. Add a **response header Transform Rule** for hostname `<CDN_HOST>` that sets `Access-Control-Allow-Origin: *`. The cache can store a response that was fetched without an `Origin` header; this rule makes every cached response usable cross-origin.
12. Optional, for a bucket with no real pages yet: upload the test fixtures.

    ```sh
    R2_BUCKET=<R2_BUCKET> npm run seed:dev -- --yes-overwrite-manifest
    ```

    > [!CAUTION]
    > This overwrites the manifests for the current and the next UTC month. Never run it against a bucket that serves real pages.

### Verify

```sh
# Loader: run twice; 200 with s-maxage in Cache-Control, and cf-cache-status: HIT the second time
curl -sI "https://<LOADER_HOST>/?page=login"

# Byte identity: the two hashes must match
curl -s https://<LOADER_HOST>/ | sha256sum
sha256sum site/index.html

# CDN: run each twice; the second shows cf-cache-status: HIT.
# Access-Control-Allow-Origin must be present with and without an Origin header.
curl -sI https://<CDN_HOST>/manifests/<YYYYMM>.json
curl -sI -H "Origin: https://<LOADER_HOST>" https://<CDN_HOST>/blobs/<hex>.html
```

Then open `https://<LOADER_HOST>/?page=login` in a browser.

## Project structure

```
site/index.html         the loader
docs/CDN-CONTRACT.md    contract for the app repository that publishes pages
scripts/
  deploy-loader.mjs     uploads site/index.html to S3 after safety checks
  seed-dev.mjs          uploads the test fixtures to a dev R2 bucket
tests/
  site.test.mjs         unit tests
  e2e.spec.mjs          Playwright tests
  fixtures/             sample pages and make-cdn.mjs, the reference publisher
```

## Limitations

- **The bucket is the trust boundary.** Anyone with write access to the R2 bucket controls what loads. [Code transparency](#planned-code-transparency) is planned to close this gap.
- **The visitor's clock picks the month.** A device with a wrong clock reads another month's manifest.
- **There is one publisher.** Each manifest assumes a single writer. With more than one, use one pointer file per page.
- **Pages are not isolated.** All pages share one origin, and there is no CSP.
- **Each query string is cached separately.** Cloudflare stores one loader copy per distinct query string, so a URL with an unusual query string goes to CloudFront and S3 on its first request.

## Planned: code transparency

> [!NOTE]
> This is a design concept. It is not implemented yet.

The loader trusts any checksum the manifest lists. Whoever can write to the bucket can serve a page that nobody else ever sees.

The planned check runs after the loader reads the checksum and before it downloads the blob:

1. The publisher records each page checksum in a public, append-only transparency log before listing it in the manifest.
2. A witness signs the state of the log. The loader embeds the witness's public key.
3. The loader verifies the witness's signature, then the proof that the checksum is included in the signed log state. If either check fails, nothing is loaded.

Every page the loader loads is then on the public log, so anyone can monitor the log and see every version that has been served.

Adopting the check requires:

- a loader update that adds the verification code and the witness key,
- a publisher that logs each checksum and supplies the proof,
- new CDN contract fields that carry the proof.

The log, the witness, the proof format and how proofs reach the loader are still open.
