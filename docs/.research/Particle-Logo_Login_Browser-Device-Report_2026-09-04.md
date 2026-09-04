# Particle Login Logo Browser and Device Report — 2026-09-04

## Release identity

- Runtime image: `tsepistle:48c96e7e`
- Image ID: `sha256:97f9064a6a8f7d6389e5adf726f96f193fe5f60ea03730fbb99039eba84c2070`
- Runtime and browser verification revision: `48c96e7ed516eaef7b0648d7564dfc0a55d27f07`
- Threat-model successor revision: `b41f4249`
- Playwright: 1.62.1
- Bundled engines: Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5
- Installed distribution check: Google Chrome 152.0.7977.82
- Deployed surface: `https://agents8c48g.tail41a24a.ts.net:10443/login`
- Active managed-logo revision: `77272185-bb45-40ad-88df-afcf20c9c25d`, pipeline v3

## Executed release rows

The final eight-project responsive suite executed 120 target/test combinations against the production image before promotion: 58 passed without retry, two intermittent decode/reduced-motion eligibility cases passed on the configured retry, and 60 inapplicable combinations were explicitly skipped by target capability. There were no terminal failures. A subsequent exact Chromium desktop run completed with 14 passes and one intentional skip; the synchronized motion case also passed independently at 1440×900 and 2560×1440.

| Project | Engine/profile | Viewport/device | Applicable result | Visual | Fallback and cleanup |
| --- | --- | --- | ---: | --- | --- |
| `responsive-chromium-desktop` | Chromium 151 | 1440×900 desktop | 14 successful, 1 intentional skip | Canonical ordinary branding, density, coherent motion, depth cue, cursor slice, recovery | Reduced motion, import/fetch/decode failure, context loss, privacy, disposal |
| `responsive-firefox-desktop` | Firefox 153 | 1440×900 desktop | 14 successful, 1 intentional skip | Same static and ordinary visual contract | Actual no-WebGL path verified as static fallback with zero enhancement work; auth remains usable |
| `responsive-webkit-desktop` | WebKit 26.5 | 1440×900 desktop | 14 successful, 1 intentional skip | Same static and ordinary visual contract | Reduced-motion teardown boundary and settled resource trace passed |
| `responsive-chromium-wide` | Chromium 151 | 2560×1440 desktop | 14 successful, 1 intentional skip | Fixed 2,000-particle wide fixture retained visible ink; motion and cursor locality passed | Full eligible-desktop fallback, auth, privacy, and cleanup contract |
| `responsive-chromium-tablet` | Chromium 151, iPad Mini landscape profile | 1133×744 | 1 passed, 14 intentional skips | Personalized field correctly omitted | Login and registration operable; zero particle request/canvas |
| `responsive-chromium-mobile` | Chromium 151, Pixel 7 profile | 412×839 | 1 successful, 14 intentional skips | Personalized field correctly omitted | Login and registration operable; zero particle request/canvas |
| `responsive-webkit-mobile` | WebKit 26.5, iPhone 13 profile | 390×664 | 1 passed, 14 intentional skips | Personalized field correctly omitted | Login and registration operable; zero particle request/canvas |
| `responsive-webkit-mobile-landscape` | WebKit 26.5, iPhone 13 landscape | 844×390 | 1 passed, 14 intentional skips | Personalized field correctly omitted | Scrollable login and registration remain operable; zero enhancement work |
| `responsive-chromium-desktop` | Google Chrome 152.0.7977.82 | 1440×900 desktop | Distribution run retained from the release matrix | Full desktop visual contract | Full fallback, privacy, authentication, and cleanup contract |

## Visual and interaction evidence

| Contract | Result |
| --- | --- |
| Ordinary logo identity | Pipeline v3 encodes the decoded, auto-oriented sRGB RGBA upload canvas before effect-only matte, trim, resize, or padding work. The active 481×481 source and live `logo.png` decode to byte-identical 481×481 RGBA pixels. |
| Transparent uploads | Browser fixtures retained transparent corner alpha and source color populations; effect processing does not mutate the canonical ordinary artifact. |
| Density and shape | Generation is bounded to 2,000–8,000 particles with deterministic component reservations and at least 0.90 reconstructed-mask IoU. The active source fell from 9,346 v2 particles to 4,673 v3 particles while retaining its orange/charcoal silhouette. |
| Idle motion | Coherent spatial waves produce a gentle 3D gaseous field with 2.5–7 CSS-pixel displacement and one bounded 0.82–1.18 depth-size cue. Source RGBA values remain particle attributes. |
| Cursor behavior | A trajectory-oriented 28–56 CSS-pixel blade produces 10–24 CSS-pixel displacement. Synchronized after-render captures proved the active corridor changes by more than 3× idle and 2× the outside region. |
| Refill | The absolute-time squared envelope reaches zero at 240 ms; synchronized recovery capture proved the corridor residual falls below half the active slice. |
| Aura | The active generated aura is `#f9a134`; an absent configured aura remains transparent. |
| Composition | Decorative field is a sibling after the login card, never intersects the card, and is absent below eligibility or with no measured free space. |
| Accessibility | Landmark, heading, textbox and button names, title, tab order, focus geometry, and enabled authentication controls match the unmanaged baseline. |
| Reduced motion at startup | Personalized static artifact rendered before mount; zero scene import, particle fetch, WebGL context, canvas, timer, RAF, idle callback, or pointer listener. |
| Reduced motion at runtime | Static opacity changed synchronously, canvas was removed, active work reached zero, and callback/resource counters did not advance after the teardown boundary. |
| Loading and GPU failures | Import, fetch, decode, corrupt-static, and context-loss paths settled to faithful static or ordinary output without loops while preserving authentication focus. |
| Visibility and layout lifecycle | Hidden and offscreen two-second windows produced zero callbacks; hard-ineligible 959px layout produced zero canvas; no late callbacks or leaked timers, RAFs, idle callbacks, or pointer listeners. |
| Privacy | Particle fetch used `credentials: omit`; requests contained no particle cookie and remained same-origin; pointer movement generated no request or telemetry. |

## Performance and resource budgets

### Runtime renderer

Measured against the deployed runtime in Chromium 151 at 1440×900, device scale factor 1.5, using the maximum supported 16,000-record decoder fixture over 20 cold runs:

| Metric | Result | Budget |
| --- | ---: | ---: |
| First rendered frame p95 | 471.5 ms | ≤ 1500 ms |
| Frame interval p95 | 17.0 ms | ≤ 20 ms |
| Frame interval p99 | 17.2 ms | ≤ 34 ms |
| Callback CPU p95 | 0.1 ms | ≤ 2 ms |
| Cold-run timeouts | 0 | 0 |
| Hidden/offscreen callback count over 2 s | 0 / 0 | 0 / 0 |
| Idle displacement diagnostic | 5.6504 CSS px | 2.5–7 CSS px |
| Slice displacement diagnostic | 16.1440 CSS px | 10–24 CSS px |
| Depth scale diagnostic | 0.82–1.18 | 0.82–1.18 |

### Production bundles

| Closure | Result | Budget |
| --- | ---: | ---: |
| Login direct JavaScript | 9,908 B gzip | 10.7 KiB gzip |
| Lazy particle scene closure | 838.8 KiB raw / 223.2 KiB gzip | 950 KiB raw / 260 KiB gzip |
| Initial login scene/Tres/Three/shader/particle assets | 0 B | 0 B |

Largest-chunk and aggregate JavaScript budgets passed in the final image build.

### Active pipeline-v3 artifacts

The active 13,151-byte source is a 481×481 PNG with SHA-256 `5ecad39758dc6fe9e357c04a0b22728f3d96d54ad8bc4374e22b39a44e257b16`. Production pipeline v3 generated and atomically activated:

| Artifact | Result |
| --- | --- |
| Canonical ordinary PNG | 481×481; decoded RGBA exactly equals the upload; SHA-256 `445c0a2a3d818fd27ab0efc6e31887a6903e331efe5868a0f82f9337781ba662` |
| Particle v1 | 447×479; 4,673 records; 56,132 bytes; valid `TSEP` v1/flags 7 header; SHA-256 `6fe1c94529809ddf9f9383c92cc407e07866e2d569a5cbeacf8e692107edace8` |
| Static effect PNG | 447×479; SHA-256 `c345218dde22893ff2c5b8b9e649184ea7af97b659b3919c3888df27cb1d56f7` |

The parser retains the 16,000-record compatibility ceiling independently of the lower 2,000–8,000 generation budget.

## Release-time browserslist accountability

No target below is inferred from another target. “Unexecuted” means the named browser distribution was not installed on this Linux workstation; engine-profile coverage above is supporting evidence, not a claim of distribution equivalence.

| Release-time target | Status and reason |
| --- | --- |
| Android Chrome 151 | Unexecuted: no Android Chrome device/distribution installed; Pixel 7 Chromium profile executed separately |
| Android Firefox 153 | Unexecuted: no Android Firefox device/distribution installed |
| QQ Browser 14.9 | Unexecuted: distribution unavailable on this Linux host |
| UC Browser 15.5 | Unexecuted: distribution unavailable on this Linux host |
| Google Chrome 151, 150, 149 | Named versions unexecuted: Google Chrome 152 was installed and executed; bundled Chromium 151 was executed separately and is not represented as Google Chrome |
| Microsoft Edge 151, 150 | Unexecuted: distributions not installed |
| Firefox 154 | Unexecuted: distribution not installed |
| Firefox 153 | Bundled Playwright Firefox 153 executed; vendor Firefox distribution not installed |
| Firefox ESR 140 | Unexecuted: ESR distribution not installed |
| iOS Safari 26.6–26.0 and 18.7–18.0 | Unexecuted: real iOS Safari cannot run on this Linux host; WebKit 26.5 iPhone 13 profiles executed separately and are not represented as Safari |
| Safari 26.6–26.0 and 18.7–18.0 | Unexecuted: real Safari cannot run on this Linux host; WebKit 26.5 desktop executed separately and is not represented as Safari |
| KaiOS 3.0–2.5 | Unexecuted: distribution/device unavailable |
| Opera Mini all | Unexecuted: distribution/device unavailable |
| Opera Mobile 80 | Unexecuted: distribution/device unavailable |
| Opera 131, 127 | Unexecuted: distributions not installed |
| Samsung Internet 30, 29 | Unexecuted: distribution/device unavailable |

## Deployment verification

Image `tsepistle:48c96e7e` was promoted to Docker container `wiki-tailnet` on `wiki-pg-migration-net`, bound to `127.0.0.1:3014`. The prior production container was retained, stopped, as `wiki-tailnet-rollback-e432698d`. The active container reports `running healthy`, embeds revision `48c96e7ed516eaef7b0648d7564dfc0a55d27f07`, and local plus tailnet `/healthz` return `200 {"ok":true}`.

The stored source was reprocessed only after the old worker stopped. Pipeline v3 revision `77272185-bb45-40ad-88df-afcf20c9c25d` reached `ready`; `activeRevisionId` and `desiredRevisionId` both reference it at state generation 5. The runtime was restarted once after atomic activation so every server process loaded the matching v3 `logoUrl` and `logoEffect` descriptor.

A real browser opened the deployed tailnet URL with title `Login | Tim O'Pedia`. In the harness profile, the lack of a fine hover pointer correctly selected fallback rendering while the ordinary image loaded from the v3 canonical URL with natural size 481×481. A separate unmocked Chromium desktop smoke against the deployed container reported fine-pointer desktop eligibility, WebGL2, a live 705×688 canvas, the exact active descriptor with 4,673 particles, and after-render idle/active/recovered frames. Pointer motion changed the rendered canvas (`activeVsIdleMean = 0.0074014`) without a network request.

Final verification: 374/374 repository test files passed; `bun run ci:static` passed dependency policy, licenses, Biome, shared/client/server types, OpenAPI, placeholder, agent release, and threat-model gates. Focused server branding tests passed 29/29; particle scene and pointer tests passed 25/25; deployed maximum-particle runtime performance passed 1/1. Independent correctness and security reviews reported no remaining finding at exact source `48c96e7ed516eaef7b0648d7564dfc0a55d27f07`.

Additional stopped rollback containers remain available: `wiki-tailnet-rollback-e6d10411`, `wiki-tailnet-rollback-16fa062`, and `wiki-tailnet-rollback-c4fc3713`.
