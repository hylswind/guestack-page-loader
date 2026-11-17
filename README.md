# Checksum loader

A minimal static site on Cloudflare Pages. Opening `https://<LOADER_HOST>/<page>`:

1. looks up the latest SHA-256 of `<page>` in a single `manifest.json` on the CDN,
2. downloads `blobs/<sha256>.html` from the CDN with Subresource Integrity,
3. if the browser verifies the checksum, replaces the current document with that HTML.

At `/` nothing is loaded and a notice is shown. On any failure an error is shown; unverified content is never loaded.

Pages are built and published by the app repository, not here. The interface between the two is [`docs/CDN-CONTRACT.md`](docs/CDN-CONTRACT.md).

```
/login ─▶ validate page name
       ─▶ fetch <CDN_BASE_URL>manifest.json      → pages.login.sha256 = <hex>
       ─▶ fetch <CDN_BASE_URL>blobs/<hex>.html with integrity
       ─▶ verified ─▶ document.write(html)

/      ─▶ show notice, make no network requests
```

## No build step

`site/` is uploaded to Cloudflare Pages as-is, byte for byte. It contains exactly two hand-written files:

- `site/index.html`: the loader (one inline script, no external resources),
- `site/_headers`: `Cache-Control: no-cache` plus security headers for every path.

There is no templating, minification, bundling, or injected value, so the file served online can be compared directly with the file in git. `.gitattributes` disables line-ending conversion under `site/`.

Do not:

- add a top-level `404.html` (it disables the Pages SPA fallback that serves the loader on every path),
- add `/* /index.html 200` to `_redirects` (wrangler rejects it as an infinite loop),
- enable any Cloudflare feature that rewrites HTML on `LOADER_HOST` (minification, Rocket Loader, email obfuscation, Web Analytics auto-injection, etc.).

## Configuration

The only setting is the `CDN_BASE_URL` literal in `site/index.html`:

```js
  const CDN_BASE_URL = "https://pub-<id>.r2.dev/";
```

In Phase 1 it is the bucket's public development URL (Infrastructure setup, step 2). The actual value lives only in `site/index.html`. `npm run deploy:loader` refuses to deploy the all-zero placeholder ID used before the bucket existed.

Moving from Phase 1 to Phase 2 is a one-line edit of this literal, a commit, and one redeploy.

Dev tooling reads `.env` (see `.env.example`): `PAGES_PROJECT` (default `loader`), `R2_BUCKET` (seed script only), `CLOUDFLARE_API_TOKEN` (or use `npx wrangler login`).

## Development

Requires Node 20+.

```sh
npm install
npx playwright install chromium   # first time, or after upgrading Playwright

npm test            # unit tests (node:test): site/ contents, CDN_BASE_URL literal, make-cdn output
npm run test:e2e    # Playwright against `wrangler pages dev site` on http://localhost:8788
```

Run a single test:

```sh
node --test --test-name-pattern="exactly one CDN_BASE_URL" tests/site.test.mjs
npx playwright test -g "tampered blob"
```

The E2E tests serve the unmodified `site/` directory. They read `CDN_BASE_URL` from `site/index.html` and answer every request to that origin from `tmp/test-cdn` (built from `tests/fixtures/pages/` by `tests/fixtures/make-cdn.mjs`) using Playwright request interception. No request reaches the real CDN; any request to an unexpected host fails the test.

Chromium does not enforce CORS on intercepted responses, so a missing CORS header cannot be simulated in the E2E tests. CORS is checked against the real bucket with `curl` (Verify, step 10).

To preview locally: `npx wrangler pages dev site`, then open http://localhost:8788/login. Without a real `CDN_BASE_URL` (and a CORS rule allowing `http://localhost:8788`) the page shows an error.

## Deploy

```sh
git commit ...          # site/ must be committed
npm run deploy:loader   # = wrangler pages deploy site --project-name $PAGES_PROJECT
```

The script refuses if `site/` has uncommitted or untracked changes, or if `CDN_BASE_URL` is still the placeholder. It never transforms files and never touches R2.

## Infrastructure setup (Phase 1)

> These steps have **not** been run. They need Cloudflare and AWS credentials. Values used below: `R2_BUCKET=loader-pages`, `PAGES_PROJECT=loader`, `LOADER_HOST` = your subdomain (e.g. `app.example.com`).

### Cloudflare

1. Create the R2 bucket (or, if the bucket already exists and belongs to another team, get its public URL from them and skip to step 3):

   ```sh
   npx wrangler r2 bucket create loader-pages
   ```

2. Enable the public development URL and write it into `site/index.html` as `CDN_BASE_URL` (with a trailing `/`), then commit:

   ```sh
   npx wrangler r2 bucket dev-url enable loader-pages
   npx wrangler r2 bucket dev-url get loader-pages    # prints https://pub-<id>.r2.dev
   ```

3. Set the bucket CORS policy:

   ```sh
   cat > /tmp/r2-cors.json <<'EOF'
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
   EOF
   npx wrangler r2 bucket cors set loader-pages --file /tmp/r2-cors.json
   npx wrangler r2 bucket cors list loader-pages
   ```

4. Only if the bucket has no real pages yet, upload the test fixtures (this **overwrites** `manifest.json`):

   ```sh
   R2_BUCKET=loader-pages npm run seed:dev -- --yes-overwrite-manifest
   ```

5. Create the Pages project, deploy, and smoke test `https://<PAGES_SUBDOMAIN>.pages.dev/login`. `<PAGES_SUBDOMAIN>` is the subdomain `project create` prints: the project name, or the name with a suffix if that subdomain is already taken. Create the project before setting CORS in step 3 if you don't know it yet.

   ```sh
   npx wrangler pages project create loader --production-branch main
   npm run deploy:loader
   ```

   Note: when wrangler (4.163 and later) detects that an AI agent is running it, `pages project create` is redirected to Cloudflare Workers instead of classic Pages. An agent must add `--force` once, at creation, to get a classic Pages project. Run by a person, the command creates a classic Pages project as usual. Deploys to an existing Pages project are not redirected.

6. Pages project → Custom domains → add `LOADER_HOST`. Do this **before** step 7; a CNAME without the Pages binding returns 522.

### AWS

7. Route 53: `LOADER_HOST  CNAME  <PAGES_SUBDOMAIN>.pages.dev`, TTL 300. If the zone has CAA records, they must allow the CAs Cloudflare uses, or certificate issuance fails.

### Verify

8. Pages shows the custom domain as Active with a certificate.
9. `curl -I https://<LOADER_HOST>/login` → `200`, `Cache-Control: no-cache`; the body is the loader.
10. CORS and object metadata:

    ```sh
    curl -sI -H "Origin: https://<LOADER_HOST>" <CDN_BASE_URL>manifest.json
    curl -sI -H "Origin: https://<LOADER_HOST>" <CDN_BASE_URL>blobs/<hex>.html
    ```

    Both: `200`, `Access-Control-Allow-Origin`, and the `Cache-Control` from the contract.
11. Open `https://<LOADER_HOST>/login` in a browser: the page loads.
12. Byte identity: `curl -s https://<LOADER_HOST>/ | sha256sum` must equal `sha256sum site/index.html`. If they differ, find and disable whatever is rewriting the response before going further.

## Phase 1 limitations

- `r2.dev` has no edge cache: every manifest and blob request is a billed R2 read, and manifest changes are visible immediately.
- `r2.dev` is rate limited (hundreds of requests per second, variable) and may throttle bandwidth. It is not for production traffic.
- Expected Phase 1 usage is far inside the R2 free tier (10 million reads, 1 million writes, 10 GB storage per month).

## Phase 2 (not implemented; do only when asked)

Before real traffic: attach a separate `CDN_HOST` (a zone in the same Cloudflare account) as a custom domain on the bucket, add a Cache Rule (hostname equals `CDN_HOST` → eligible for cache, edge TTL respects origin `Cache-Control`), add a Response Header Transform Rule that always sets `Access-Control-Allow-Origin: *` and `X-Content-Type-Options: nosniff` (the edge cache can otherwise replay a response stored without CORS headers), change `CDN_BASE_URL` to `https://<CDN_HOST>/`, commit, redeploy, repeat the byte-identity check, then disable the `r2.dev` URL. To verify, request a blob and `manifest.json` twice with `curl -I`: the second response must have `cf-cache-status: HIT`, `Access-Control-Allow-Origin` (also when the request has no `Origin` header), and the `Cache-Control` from the contract.

**Cost with the edge cache:** a manifest change becomes visible within `MANIFEST_TTL` seconds, and R2 is read at most once per TTL per edge location regardless of traffic or page count. At `MANIFEST_TTL = 60` that is at most

```
43,200 × (edge locations with traffic)   Class B reads per month for the manifest
```

Blobs are immutable and cached for a year, so they add roughly one read per blob per edge location.

## Known limits

- Anyone with write access to the bucket can change what loads. Signing the manifest (Ed25519/ECDSA, verified in the loader with an embedded public key via WebCrypto, with a monotonic version to prevent replay) would remove the CDN from the trust boundary.
- The shared manifest assumes a single publisher. With more than one, switch to one pointer file per page.
- No CSP.
- Pages share one origin and are not isolated from each other.
