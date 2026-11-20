# CDN Contract

The interface between the loader (this repository) and the app repository that publishes pages. A publisher can be implemented from this document alone.

[How the loader reads the CDN](#how-the-loader-reads-the-cdn) • [Objects](#objects) • [Manifest](#manifest) • [Publishing](#publishing) • [Writing pages](#writing-pages) • [Trust model](#trust-model)

> [!IMPORTANT]
> The loader is deployed once and is meant to stay unchanged. The parts it reads are **frozen**: the key `manifests/<YYYYMM>.json`, `pages.<name>.sha256` inside it, and the object at `blobs/<hex>.html` must never change meaning.

## How the loader reads the CDN

For a request to `https://<LOADER_HOST>/<page>`, the loader:

1. checks that `<page>` matches `^[a-z0-9][a-z0-9-]{0,63}$`, and otherwise shows an error without making a request,
2. fetches the current month's manifest, `<CDN_BASE_URL>manifests/<YYYYMM>.json` (see [Monthly manifests](#monthly-manifests)),
3. reads `pages.<page>.sha256`, and shows "Page not found." if there is no entry,
4. fetches `<CDN_BASE_URL>blobs/<sha256>.html` with the `fetch()` [`integrity`](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit#integrity) option set to `sha256-<base64 of the same digest>`, so the browser rejects the response if its hash does not match,
5. decodes the body as UTF-8 and replaces the current document with it using `document.open/write/close`.

If any step fails, nothing is loaded.

## Objects

| Key | Content |
| --- | --- |
| `manifests/<YYYYMM>.json` | The manifest for one UTC month. See [Manifest](#manifest). |
| `blobs/<hex>.html` | The page's exact bytes. `<hex>` is their SHA-256: 64 lowercase hex characters, as printed by `sha256sum`. |

> [!WARNING]
> Hash exactly the bytes you upload. Any re-encoding or newline conversion between hashing and uploading makes verification fail.

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

- `version` is the version of this file format and is always `1`. The loader does not read it.
- `pages` is an object. Each key is a page name; each value is an object with a `sha256` string.
- Page names match `^[a-z0-9][a-z0-9-]{0,63}$`. `index` is reserved: `/index` redirects to `/`, so such a page is unreachable.
- A page exists if and only if it has an entry.
- Unknown fields are ignored, so metadata can be added at the top level or inside entries.

### Monthly manifests

- `YYYYMM` is the current year and month in UTC, as read from the visitor's clock. For example, from `2026-12-01T00:00:00Z` the loader reads `manifests/202612.json`.
- Each manifest is complete on its own: it lists every page available that month. A page missing from the current month's manifest is "Page not found." even if an earlier month listed it.
- If the current month's manifest is missing or invalid, every page shows "Unable to look up the page." The loader never falls back to another month.

## Publishing

### Rules

1. **Blob first, manifest last.** Upload the blob, confirm it is reachable, then update the manifest. A manifest must never reference a blob that is not live.
2. **Publish each month in advance.** Upload a month's manifest, and every blob it references, before 00:00 UTC on the 1st of that month. A month's manifest can still be updated during the month. Never change a past month's manifest.
3. **Blobs are immutable.** Never overwrite a blob with different bytes, and never delete a blob that is still referenced. Keeping old blobs makes a rollback a manifest edit.
4. **One publisher.** The app repository owns the manifests and writes each one as a whole file, with every page, on each publish. Concurrent writers would overwrite each other's entries.
5. **CORS.** Manifests and blobs are fetched cross-origin with `mode: "cors"` and `credentials: "omit"`. `GET` and `HEAD` responses must include `Access-Control-Allow-Origin` for every loader origin:
   - `https://<LOADER_HOST>`
   - `https://<PAGES_SUBDOMAIN>.pages.dev`

### Example

Publishing one page for December 2026 to R2 with wrangler:

```sh
hex=$(sha256sum dist/login.html | cut -d' ' -f1)
npx wrangler r2 object put "<BUCKET>/blobs/$hex.html" --remote --file dist/login.html

# Confirm the blob is reachable, then write that month's full manifest
npx wrangler r2 object put "<BUCKET>/manifests/202612.json" --remote --file manifest.json
```

### Reference implementation

- [`tests/fixtures/make-cdn.mjs`](../tests/fixtures/make-cdn.mjs) builds `blobs/<hex>.html` and `manifests/<YYYYMM>.json` from a directory of pages, using only Node built-ins.
- [`scripts/seed-dev.mjs`](../scripts/seed-dev.mjs) uploads them in the required order, for the current and the next month.

Both are dev tools, not production publishing tools.

## Writing pages

Each page is written into the loader's document with `document.write`. For page authors this means:

| Topic | Rule |
| --- | --- |
| Encoding | Pages must be UTF-8. |
| URLs | Relative URLs resolve against `https://<LOADER_HOST>/<page>`, where every path serves the loader itself. Inline CSS and JS, or use absolute URLs or `<base href>`. |
| External resources | The checksum covers only the HTML. An external script or stylesheet needs its own `integrity` attribute and `crossorigin="anonymous"`, and must be served with CORS headers. |
| Query string and hash | Preserved. Pages can read `location.search` and `location.hash`. |
| CSP | A Content-Security-Policy on the loader response also applies to pages. There is none at present. |
| Isolation | All pages share one origin, including cookies and `localStorage`. |

## Trust model

The bucket decides what is loaded. The checksum guarantees that the blob matches the manifest, which rules out corruption and partial or mixed versions. It does not protect against anyone who can write to the bucket, so restrict write access accordingly. A transparency-log check is planned; see [Planned: code transparency](../README.md#planned-code-transparency).
