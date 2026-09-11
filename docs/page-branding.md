# Page branding

Page branding is an optional Page Properties setting. It attaches an existing image asset to a page by asset ID and presents that asset as a decorative header mark. The reader uses the original asset bytes, including their native transparency; v2 may derive a small accent value for presentation, but it never rewrites, flattens, or replaces the image. The page owns the assignment, not a copy of the asset.

## Page Properties workflow

1. Open **Page Properties** in the editor. The modal edits a draft, including the current branding assignment and its last resolved view. Cancel rolls the draft back; **OK** commits the draft to the editor state.
2. Choose **Select** (or **Replace**) to open the media picker. Branding mode only lists assets whose kind is `IMAGE` and whose extension is `.png`, `.jpg`, `.jpeg`, or `.webp`. Selecting an asset loads `GET /_api/assets/:id/branding` with `deriveIfMissing=true`, after authorization, and `no-store` caching. The picker enables **Use image** only when the returned descriptor is valid and has the same asset ID as the selection.
3. Choose **Remove** to set the draft assignment to `null`.
4. Saving a new page sends `branding: { assetId }` when an image is selected. Updating an existing page sends `branding` only when the assignment changed; `null` removes the assignment. The normal page write includes the expected source revision, so a stale editor cannot overwrite a newer Page Properties change.

The canonical assignment is deliberately small and stable:

```json
{ "assetId": 123 }
```

The server validates it as a positive safe integer, checks authorization, and stores it in the existing `pages.extra.branding` JSON member. It does not trust a client-supplied image URL, source digest, dimensions, or accent.

## V2 analysis and derived view

There are two different contracts:

- **Canonical assignment** — the page-owned `{ assetId }` reference in `pages.extra.branding`. It is the value edited, saved, history-snapshotted, and restored. It is exposed as `brandingAssignment` only to a page writer or system manager; it is removed from generic `extra` responses.
- **Derived asset metadata** — `assets.metadata.branding`, derived from the asset source and cached with that source's SHA-256. A v2 ready entry contains `version: 2`, `sourceSha256`, `state: "ready"`, oriented `width` and `height`, and `accent: "#RRGGBB" | null`. An unavailable entry contains `version: 2`, the source digest, `state: "unavailable"`, and one of the documented failure reasons. V2 has no generated branding image or matte field: the image URL resolves the original asset bytes and therefore preserves the source's RGB values and alpha.
- **Derived page view** — reader/editor projections turn ready metadata into a safe `PageBrandingView` containing the asset ID, a same-origin path-encoded URL, the source digest, dimensions, and the nullable accent. The URL is versioned as `?v=<sourceSha256>` so a committed source replacement gets a new image identity. The view is not page source and is never authoritative over the assignment.

Analysis hashes the original source bytes before classification. It accepts only static PNG, JPEG, and WebP input, auto-orients the decoded image for its reported dimensions, converts only an analysis sample to sRGB with an alpha channel, and resizes that sample to fit within 64 pixels in either direction without enlargement. The sample is used only to derive the optional accent; the original bytes remain the bytes served to the browser. Fully transparent pixels contribute no color, and neutral or insufficiently chromatic visible content produces a ready entry with `accent: null`, not an unavailable result.

## Input contract and limits

The server recognizes image bytes, not just filename extensions. Supported input is **static PNG, JPEG, or WebP**. Animated PNG/APNG, animated WebP, vector/SVG, other formats, malformed containers, multi-page input, and invalid image metadata are unavailable. The picker’s extension filter is only a convenience; server validation remains authoritative.

The current shared constants are:

| Constant | Limit | Operational meaning |
| --- | ---: | --- |
| `PAGE_BRANDING_MAX_SOURCE_BYTES` | `5,242,880` bytes (5 MiB) | Maximum source blob size; larger input is `too-large`. |
| `PAGE_BRANDING_MAX_INPUT_DIMENSION` | `4,096` | Maximum width and maximum height. |
| `PAGE_BRANDING_MAX_INPUT_PIXELS` | `16,777,216` pixels (`4,096²`) | Maximum decoded input area. |
| `PAGE_BRANDING_SAMPLE_DIMENSION` | `64` pixels | The analysis raster is resized to fit within 64 px in each direction, without enlargement; it does not replace the source image. |

The branding metadata format is versioned with `PAGE_BRANDING_VERSION = 2`. A completed analysis is either `ready` or `unavailable` with one of `unsupported`, `invalid`, `too-large`, or `processing-failed`. Unavailable metadata is tied to the exact source SHA-256 and is not projected as a ready view. A nullable accent is the only tolerant member of an otherwise strict ready/view descriptor: an invalid or missing accent normalizes to `null`, while malformed identity, URL, digest, dimensions, or unrelated fields invalidate the whole descriptor.

## Cache cutover, freshness, atomicity, and bounded admission

Authorization happens before source reads or analysis. After authorization, descriptor resolution follows this cache matrix:

| Asset metadata state | Resolution behavior |
| --- | --- |
| Current v2 `ready` member | Use the cached metadata to build the view; no source-blob read or re-analysis is required. |
| Current v2 `unavailable` member | Return the neutral/unavailable result without retrying analysis, including when `deriveIfMissing=true`. |
| Existing non-null malformed or historical v1 branding member | Lazily refresh and replace it with a v2 result, even when `deriveIfMissing=false`. Historical fields are input to this cutover only; they are never projected or preserved as a mixed-version view. |
| No `branding` member at all | Refresh only when `deriveIfMissing=true`; otherwise return the neutral/missing result. |

The media picker opts into derivation for a truly missing member. Reader and editor projections otherwise retain the current ready, unavailable, and missing semantics above. `BRANDING_BUSY` is not a compatibility fallback.

When a refresh is admitted, it reads an asset/source snapshot, hashes the source, and reuses a parsed cache hit only when its digest matches that snapshot. New analysis is merged in a transaction while the asset row is locked; the merge rechecks the current blob hash before writing `assets.metadata.branding`. The source and metadata are read again after the merge, and a descriptor is returned only when the digest still matches. A source that changes during processing is retried up to `MAX_FRESHNESS_RETRIES = 3`; an unstable refresh returns no view rather than a mismatched descriptor.

Asset replacement performs branding analysis and the `assets`/`assetData` update in the same database transaction when the existing asset carries a branding metadata member. Cache and storage side effects occur only after that transaction commits. Same-hash uploads are serialized by the upload flight.

Work is bounded by `MAX_ACTIVE_BRANDING_ANALYSES = 8`, counting active analyses and reservations. Per-asset single-flight prevents duplicate analysis for the same asset. Invalid, duplicate, or over-capacity admission fails with `BRANDING_BUSY` and HTTP `503`.

`503 BRANDING_BUSY` is a retryable admission response, not an analysis result. It is never converted into `processing-failed`, never written as an `unavailable` metadata entry, and never used as a negative cache. Retry the descriptor request after capacity becomes available. In contrast, a completed analysis that discovers an unsupported, invalid, too-large, or processing-failed source may persist that reason for the matching source digest.

## Authorization and protected assets

Asset authorization is checked independently from page authorization:

- Assignment writes and branding-view reads authorize the resolved asset path through the existing path-scoped `manage:system`/`read:assets` check. An asset that is missing or not readable is treated as not found; an asset that is readable but locked by page protection returns access denied.
- A page mutation cannot assign an asset whose branding is not ready (`BRANDING_UNAVAILABLE`, HTTP `422`). The check is repeated on every changed assignment, including restore; an invalid or historical cache is refreshed only after this authorization succeeds.
- Public page access still follows the page’s path/locale/tag rules. Private page access is limited to the private owner or a system manager. Neither page visibility nor private ownership silently grants `read:assets`; the requester must satisfy both page and asset checks.
- Page-password protection also covers a referenced branding asset. A non-manager needs a valid, current session unlock for a protected page that references the asset. System managers bypass the page-password unlock check.

The branding descriptor endpoint is `private, no-store`, and the client also requests it with `cache: no-store`. The image URL is same-origin, path-encoded, and versioned by the source digest so a changed blob does not reuse an old image URL.

## Presentation and accessibility

The reader header reserves a transparent, non-cropping mark box whose responsive size is:

- `80px` below `600px`,
- `96px` from `600px`,
- `128px` from `1280px`.

The source image is contained inside that box with its original aspect ratio and alpha. In both left-to-right and right-to-left layouts, the mark remains in the physical right branding cell; text and navigation continue to follow the active direction. When an accent is present, the header container paints a low-opacity gradient across its physical rightmost third, strongest in the upper-right and fading toward the lower-left. The source-faithful mark is layered above that gradient, which never expands the header height or washes over the title and description. The title and description stay on the ordinary theme surface and use the ordinary theme text palette.

Accent presentation is blending, not a contrast veto: light themes use accent alpha `0.28`, dark themes use `0.24`, with the fade tapering to transparent. A neutral or `null` accent still renders the source-faithful image but renders no gradient. There is no opaque accent panel, flat tint, or divider replacing the standard theme surface.

Branding is decorative and enhancement-only:

- The mark is `aria-hidden="true"` and its image has empty alt text, so page identity remains the title and description.
- Strict view validation rejects malformed or mismatched assignment/view data. The client normalizes an invalid view to `null`; a malformed accent alone is normalized to `null` and does not discard an otherwise valid image.
- An unavailable or missing view renders no mark and no reserved branding region. An image load failure is tracked by the current `assetId:sourceSha256` identity; the mark and its gradient are removed for that identity, and the layout recovers when the identity changes.
- Reader-side resolution catches asset lookup, authorization, lock, freshness, and unavailable-branding failures and projects `branding: null` while returning the page normally. The direct descriptor endpoint can still return `BRANDING_BUSY` for retry.
- In the editor, an assignment whose view is unavailable is shown as unavailable so an authorized editor can replace or remove it; it is not silently changed in the canonical page.
- Print and forced-colors modes suppress both the image mark and accent gradient and fall back to the normal unbranded heading and system-safe text colors.

## History and exports

Page history versions snapshot the page’s branding **assignment**, just like the other JSON members of `extra`. Reading a historical version resolves that assignment against the asset that exists now; restoring a version reassigns the recorded asset ID and performs current authorization again. History never copies or versions asset bytes. If the asset is deleted, inaccessible, locked, or no longer has a ready descriptor, the historical branding view is `null`.

Branding is excluded from source-only representations. The `/s` source view contains canonical page content, and `/d` downloads use the storage encoder (Markdown/OKF or the existing legacy serializer); those encoders consume page fields and `extra.okf`, not `extra.branding`. No branding assignment, derived descriptor, or asset bytes are embedded in a page source export.

## Storage and deployment

No schema migration is required. The assignment uses the existing page `extra` JSON, v2 derived metadata uses the existing asset `metadata` JSON, and source bytes remain in the existing `assetData` blob. The branding payload version (`2`) is an application metadata version, not a database migration version.

Implementation references: `shared/page-branding.ts` defines the schemas and limits; `server/helpers/asset-branding.ts` owns analysis, freshness, admission, authorization, cache cutover, and view derivation; `server/models/pages.ts` owns assignment persistence; `server/operations/pages.ts` owns page projections/history/restore; and `server/modules/storage/page-document.ts` owns source/download encoding.
