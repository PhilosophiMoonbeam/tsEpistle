# Page branding

Page branding is an optional Page Properties setting. It adds a small image mark and, when safe for the active theme, a restrained accent to the page header. The page does not own a copy of the image: it references an existing asset by ID.

## Page Properties workflow

1. Open **Page Properties** in the editor. The modal edits a draft, including the current branding assignment and its last resolved view. Cancel rolls the draft back; **OK** commits the draft to the editor state.
2. Choose **Select** (or **Replace**) to open the media picker. Branding mode only lists assets whose kind is `IMAGE` and whose extension is `.png`, `.jpg`, `.jpeg`, or `.webp`. Selecting an asset loads `GET /_api/assets/:id/branding` with `deriveIfMissing=true` and `no-store` caching. The picker enables **Use image** only when the returned descriptor is valid and has the same asset ID as the selection.
3. Choose **Remove** to set the draft assignment to `null`.
4. Saving a new page sends `branding: { assetId }` when an image is selected. Updating an existing page sends `branding` only when the assignment changed; `null` removes the assignment. The normal page write includes the expected source revision, so a stale editor cannot overwrite a newer Page Properties change.

The canonical assignment is deliberately small and stable:

```json
{ "assetId": 123 }
```

The server validates it as a positive safe integer, checks authorization, and stores it in the existing `pages.extra.branding` JSON member. It does not trust a client-supplied image URL, digest, dimensions, accent, or matte.

## Canonical assignment versus derived view

There are two different contracts:

- **Canonical assignment** — the page-owned `{ assetId }` reference in `pages.extra.branding`. It is the value edited, saved, history-snapshotted, and restored. It is exposed as `brandingAssignment` only to a page writer or system manager; it is removed from generic `extra` responses.
- **Derived view** — `assets.metadata.branding`, derived from the current bytes in `assetData`. A ready view contains branding version `1`, the source SHA-256, oriented width and height, an optional accent, and an optional deterministic matte. Reader/editor projections turn that metadata into a safe `PageBrandingView` with a same-origin, digest-versioned URL (`?v=<sourceSha256>`). The view is not page source and is never authoritative over the assignment.

A ready descriptor is resolved against the current asset bytes. If the asset was replaced, its source digest changes and the derived view/URL changes; the page assignment does not need to be rewritten.

## Input contract and limits

The server recognizes image bytes, not just filename extensions. Supported input is **static PNG, JPEG, or WebP**. Animated PNG/APNG, animated WebP, vector/SVG, other formats, malformed containers, multi-page input, and invalid image metadata are unavailable. The picker’s extension filter is only a convenience; server validation remains authoritative.

The current shared constants are:

| Constant | Limit | Operational meaning |
| --- | ---: | --- |
| `PAGE_BRANDING_MAX_SOURCE_BYTES` | `5,242,880` bytes (5 MiB) | Maximum source blob size; larger input is `too-large`. |
| `PAGE_BRANDING_MAX_INPUT_DIMENSION` | `4,096` | Maximum width and maximum height. |
| `PAGE_BRANDING_MAX_INPUT_PIXELS` | `16,777,216` pixels (`4,096²`) | Maximum decoded input area. |
| `PAGE_BRANDING_SAMPLE_DIMENSION` | `64` pixels | The raster used for accent/matte analysis is resized to fit within 64 px in each direction, without enlargement. |

The branding metadata format itself is versioned with `PAGE_BRANDING_VERSION = 1`. A derived result is either `ready` or `unavailable` with one of `unsupported`, `invalid`, `too-large`, or `processing-failed`. Unavailable metadata is tied to the exact source SHA-256 and is not projected as a ready view.

## Freshness, atomicity, and bounded admission

Branding metadata is a cache of a particular source digest, not an independent source of truth.

- A refresh reads the asset row and blob, hashes the blob, and uses cached metadata only when its `sourceSha256` matches that hash.
- New metadata is merged in a transaction while the asset row is locked. The merge rechecks the current blob hash before writing `assets.metadata.branding`, so a replacement cannot publish metadata for a different blob.
- After the merge, the source and metadata are read again. A descriptor is returned only when the source digest is still the derived digest. A source that changes during processing is retried up to `MAX_FRESHNESS_RETRIES = 3`; an unstable refresh returns no view rather than returning a mismatched ready descriptor.
- Asset replacement performs the branding analysis and the `assets`/`assetData` update in the same database transaction when the existing asset carries branding metadata. Cache and storage side effects occur only after that transaction commits. Same-hash uploads are serialized by the upload flight.
- Work is bounded by `MAX_ACTIVE_BRANDING_ANALYSES = 8`, counting active analyses and reservations. Per-asset single-flight prevents duplicate analysis for the same asset. Invalid, duplicate, or over-capacity admission fails with `BRANDING_BUSY` and HTTP `503`.

`503 BRANDING_BUSY` is a retryable admission response, not an analysis result. It is never converted into `processing-failed`, never written as an `unavailable` metadata entry, and never used as a negative cache. Retry the descriptor request after capacity becomes available. In contrast, a completed analysis that discovers an unsupported, invalid, too-large, or processing-failed source may persist that reason for the matching source digest.

## Authorization and protected assets

Asset authorization is checked independently from page authorization:

- Assignment writes and branding-view reads authorize the resolved asset path through the existing path-scoped `manage:system`/`read:assets` check. An asset that is missing or not readable is treated as not found; an asset that is readable but locked by page protection returns access denied.
- A page mutation cannot assign an asset whose current branding is not ready (`BRANDING_UNAVAILABLE`, HTTP `422`). The check is repeated on every changed assignment, including restore.
- Public page access still follows the page’s path/locale/tag rules. Private page access is limited to the private owner or a system manager. Neither page visibility nor private ownership silently grants `read:assets`; the requester must satisfy both page and asset checks.
- Page-password protection also covers a referenced branding asset. A non-manager needs a valid, current session unlock for a protected page that references the asset. System managers bypass the page-password unlock check.

The branding descriptor endpoint is `private, no-store`, and the client also requests it with `cache: no-store`. The image URL is same-origin, path-encoded, and versioned by the source digest so a changed blob does not reuse an old image URL.

## History and exports

Page history versions snapshot the page’s branding **assignment**, just like the other JSON members of `extra`. Reading a historical version resolves that assignment against the asset that exists now; restoring a version reassigns the recorded asset ID and performs current authorization again. History never copies or versions asset bytes. If the asset is deleted, inaccessible, locked, or no longer has a ready descriptor, the historical branding view is `null`.

Branding is excluded from source-only representations. The `/s` source view contains canonical page content, and `/d` downloads use the storage encoder (Markdown/OKF or the existing legacy serializer); those encoders consume page fields and `extra.okf`, not `extra.branding`. No branding assignment, derived descriptor, or asset bytes are embedded in a page source export.

## Neutral fallbacks

Branding is enhancement-only and must not make a page unreadable:

- Reader-side resolution catches asset lookup, authorization, lock, freshness, and unavailable-branding failures and projects `branding: null` while returning the page normally.
- Strict view validation rejects malformed or mismatched assignment/view data. The client normalizes an invalid view to `null`.
- A missing/invalid view renders no mark. An accent that fails the theme contrast checks produces no accent surface or divider; the normal theme remains in force. A failed image load suppresses the current digest identity and removes the branding styling until the identity changes.
- In the editor, an assignment whose view is unavailable is shown as unavailable so an authorized editor can replace or remove it; it is not silently changed in the canonical page.

## Storage and deployment

No schema migration is required. The assignment uses the existing page `extra` JSON, derived metadata uses the existing asset `metadata` JSON, and source bytes remain in the existing `assetData` blob. The branding payload version (`1`) is an application metadata version, not a database migration version.

Implementation references: `shared/page-branding.ts` defines the schemas and limits; `server/helpers/asset-branding.ts` owns analysis, freshness, admission, authorization, and view derivation; `server/models/pages.ts` owns assignment persistence; `server/operations/pages.ts` owns page projections/history/restore; and `server/modules/storage/page-document.ts` owns source/download encoding.
