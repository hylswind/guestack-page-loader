# CDN contract

This is the only interface between the loader (this repository) and the app repository that publishes pages. Implement against this document; you do not need to read the loader code.

The loader is deployed once and is meant to stay unchanged. The parts it reads are **frozen**: `pages.<name>.sha256` in `manifest.json` and the object at `blobs/<hex>.html` must never change meaning.

## How the loader uses the CDN

For a request to `https://<LOADER_HOST>/<page>`, the loader:

1. checks that `<page>` matches `^[a-z0-9][a-z0-9-]{0,63}$` (otherwise it shows an error and makes no request),
2. fetches `<CDN_BASE_URL>manifest.json`,
3. reads `pages.<page>.sha256` (if there is no entry, it shows "Page not found"),
4. fetches `<CDN_BASE_URL>blobs/<sha256>.html` with Subresource Integrity `sha256-<base64 of the same digest>`,
5. replaces the current document with the response body via `document.open/write/close`.

If verification fails at any step, nothing is loaded.

## Objects

| Key | Content | Content-Type | Cache-Control |
|---|---|---|---|
| `manifest.json` | see below | `application/json` | `public, max-age=60` |
| `blobs/<hex>.html` | the page's exact bytes; `<hex>` = lowercase SHA-256 of those bytes | `text/html; charset=utf-8` | `public, max-age=31536000, immutable` |

- `<hex>` is 64 lowercase hex characters, exactly as printed by `sha256sum`. Hash the raw bytes you upload: no re-encoding and no newline conversion between hashing and uploading.
- The manifest's `max-age` (`MANIFEST_TTL`, 60 seconds) is how long a manifest change can take to become visible once an edge cache is in front of the bucket.

## Manifest format

```json
{
  "version": 1,
  "pages": {
    "login": { "sha256": "<64 hex>" },
    "home":  { "sha256": "<64 hex>" }
  }
}
```

- `version` is the version of the **manifest file format** (this schema), not of the content. It is always `1` for now and does not change when pages are published. The loader does not read it.
- `pages` is an object. Each key is a page name; each value is an object with a `sha256` string.
- Page names match `^[a-z0-9][a-z0-9-]{0,63}$`. The name `index` is reserved.
- A page exists if and only if it has an entry.
- The loader ignores unknown fields, so you may add metadata (at the top level or inside entries).

## Rules for publishers

1. **Blob first, manifest last.** Upload the blob, confirm it is reachable, then update the manifest. The manifest must never reference a blob that is not live.
2. **Blobs are immutable.** Never overwrite a blob with different bytes, and never delete a blob that is still referenced. Keeping all old blobs makes rollback a manifest edit.
3. **Single publisher.** The app repository owns `manifest.json` and writes it as a whole (all pages) on each publish; no merging with the live manifest is needed. If a second publisher is ever added, this assumption breaks (concurrent writes would overwrite each other) and this contract must be revisited.
4. **CORS.** Both requests are cross-origin, and `fetch` with `integrity` requires a CORS-enabled response. Responses must carry `Access-Control-Allow-Origin` for the loader origin (`https://<LOADER_HOST>`, `https://<PAGES_PROJECT>.pages.dev`) for `GET` and `HEAD`. The loader requests with `mode: "cors"` and `credentials: "omit"`.

## Rules for page authors

These follow from the page being written into the loader's document with `document.write`.

- **The URL and origin stay the loader's.** Relative URLs in a page resolve against `https://<LOADER_HOST>/<page>`, not the CDN. Pages must be self-contained (inline CSS and JS) or use absolute URLs or `<base href>`.
- **The checksum covers only the HTML.** External JS or CSS referenced by a page needs its own `integrity` attribute to be protected.
- **Query string and hash are preserved.** Pages can read `location.search` and `location.hash`; the loader does not touch them.
- **CSP.** Any Content-Security-Policy on the loader response also applies to loaded pages. There is none at present.
- **No isolation between pages.** All pages share one origin (cookies, `localStorage`, etc.).

## Trust model

The bucket decides what is loaded. The checksum guarantees that the blob matches the manifest (no corruption, no partial or mixed versions, safe long-term caching). It does not protect against someone who can write to the bucket, so restrict R2 write credentials accordingly. A signed manifest is a possible later hardening step.

## Reference implementation

[`tests/fixtures/make-cdn.mjs`](../tests/fixtures/make-cdn.mjs) builds a contract-compliant tree (`blobs/<hex>.html` and `manifest.json`) from a directory of pages, using only Node built-ins. [`scripts/seed-dev.mjs`](../scripts/seed-dev.mjs) shows the upload order and object metadata with `wrangler r2 object put`. Both are dev tools in this repository, not production publish tooling.
