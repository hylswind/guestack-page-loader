# CDN Contract

This document is the interface between the loader (this repository) and the app repository that publishes pages. It is written for whoever maintains that app repository. You can implement a publisher from this document alone, without reading the loader code.

[How the loader reads the CDN](#how-the-loader-reads-the-cdn) • [Objects](#objects) • [Manifest](#manifest) • [Publishing](#publishing) • [Writing pages](#writing-pages) • [Trust model](#trust-model)

> [!IMPORTANT]
> The loader is deployed once and is meant to stay unchanged. The parts it reads are **frozen**. `pages.<name>.sha256` in `manifest.json` and the object at `blobs/<hex>.html` must never change meaning.

## How the loader reads the CDN

For a request to `https://<LOADER_HOST>/<page>`, the loader takes these steps:

1. It checks that `<page>` matches `^[a-z0-9][a-z0-9-]{0,63}$`. If it doesn't, the loader shows an error and makes no request.
2. It fetches `<CDN_BASE_URL>manifest.json`.
3. It reads `pages.<page>.sha256`. If there is no entry, it shows "Page not found."
4. It fetches `<CDN_BASE_URL>blobs/<sha256>.html` with Subresource Integrity `sha256-<base64 of the same digest>`.
5. It replaces the current document with the response body, using `document.open/write/close`.

If any step fails, nothing is loaded.

## Objects

| Key | Content | Content-Type | Cache-Control |
| --- | --- | --- | --- |
| `manifest.json` | See [Manifest](#manifest). | `application/json` | `public, max-age=60` |
| `blobs/<hex>.html` | The page's exact bytes. | `text/html; charset=utf-8` | `public, max-age=31536000, immutable` |

`<hex>` is the SHA-256 of the blob's bytes: 64 lowercase hex characters, exactly as `sha256sum` prints them.

> [!WARNING]
> Hash exactly the bytes you upload. Re-encoding or newline conversion between hashing and uploading makes the checksum fail, and the page will not load.

The manifest's `max-age` of 60 seconds is the manifest TTL. When an edge cache sits in front of the bucket, a manifest change can take up to this long to become visible.

## Manifest

```json
{
  "version": 1,
  "pages": {
    "login": { "sha256": "<64 hex>" },
    "home":  { "sha256": "<64 hex>" }
  }
}
```

- `version` is the version of this file format, not of the content. It is `1` and does not change when pages are published. The loader does not read it.
- `pages` is an object. Each key is a page name, and each value is an object with a `sha256` string.
- Page names match `^[a-z0-9][a-z0-9-]{0,63}$`. The name `index` is reserved.
- A page exists if and only if it has an entry.
- The loader ignores unknown fields. You can add metadata at the top level or inside entries.

## Publishing

### Rules

1. **Upload the blob first and the manifest last.** Confirm the blob is reachable before you update the manifest. The manifest must never reference a blob that is not live.
2. **Never change a blob.** Never overwrite a blob with different bytes, and never delete a blob that is still referenced. If you keep all old blobs, a rollback is just a manifest edit.
3. **Use one publisher.** The app repository owns `manifest.json` and rewrites the whole file, with every page, on each publish. You never need to merge with the live manifest. A second publisher would break this, because concurrent writes would overwrite each other.
4. **Allow CORS.** The loader fetches both objects cross-origin with `mode: "cors"` and `credentials: "omit"`, and an `integrity` check requires a CORS-enabled response. For `GET` and `HEAD`, responses must include `Access-Control-Allow-Origin` for every loader origin:
   - `https://<LOADER_HOST>`
   - `https://<PAGES_SUBDOMAIN>.pages.dev`

### Example

This example publishes one page with wrangler:

```sh
hex=$(sha256sum dist/login.html | cut -d' ' -f1)

npx wrangler r2 object put "<BUCKET>/blobs/$hex.html" --remote --file dist/login.html \
  --content-type "text/html; charset=utf-8" \
  --cache-control "public, max-age=31536000, immutable"

# Confirm the blob is reachable, then write the full manifest
npx wrangler r2 object put "<BUCKET>/manifest.json" --remote --file manifest.json \
  --content-type "application/json" \
  --cache-control "public, max-age=60"
```

### Reference implementation

- [`tests/fixtures/make-cdn.mjs`](../tests/fixtures/make-cdn.mjs) builds a tree that follows this contract (`blobs/<hex>.html` plus `manifest.json`) from a directory of pages. It uses only Node built-ins.
- [`scripts/seed-dev.mjs`](../scripts/seed-dev.mjs) shows the upload order and the object metadata.

Both are dev tools for this repository. They are not production publishing tools.

## Writing pages

The loader writes each page into its own document with `document.write`. That has these consequences for page authors:

| Topic | Consequence |
| --- | --- |
| URL and origin | Relative URLs resolve against `https://<LOADER_HOST>/<page>`, not against the CDN. Keep pages self-contained with inline CSS and JS, or use absolute URLs or `<base href>`. |
| External resources | The checksum covers only the HTML. Each external script or stylesheet needs its own `integrity` attribute to be protected. |
| Query string and hash | Both are preserved. Pages can read `location.search` and `location.hash`. |
| CSP | A Content-Security-Policy on the loader response would also apply to pages. There is none at present. |
| Isolation | All pages share one origin, so they share cookies, `localStorage` and similar storage. |

## Trust model

The bucket decides what is loaded.

The checksum guarantees that the blob matches the manifest. That rules out corruption and partial or mixed versions, and makes long-term caching safe.

The checksum does not protect against someone who can write to the bucket. Restrict R2 write credentials accordingly. A signed manifest is a possible future hardening step.
