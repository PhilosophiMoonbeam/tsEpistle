# Particle Login Logo Browser and Device Report — 2026-09-04

## Release identity

- Runtime image: `tsepistle:e432698d`
- Image digest: `sha256:819f2d6d2aebb1199426a5b872238cc478a3633fde5f3f9f69eb513d0e281b97`
- Runtime source revision: `e432698d4fd8e6b12c485a8a778e24dd79cf9bef`
- Browser verification revision: `eb4145fa`
- Playwright: 1.62.1
- Bundled engines: Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5
- Installed distribution check: Google Chrome 152.0.7977.82
- Deployed surface: `https://agents8c48g.tail41a24a.ts.net:10443/login`

## Executed release rows

The eight-project suite executed 112 target/test combinations against the production image before promotion: 55 passed on the first attempt, one passed on the configured retry, and 56 inapplicable combinations were explicitly skipped by target capability. There were no terminal failures. The recovered Chromium case was traced to host network churn: an independent 12-navigation reproduction captured `net::ERR_NETWORK_CHANGED` on application script requests while the document remained HTTP 200. The same host transient occurred under the installed Google Chrome distribution. It is not a particle fallback, authentication, or application assertion failure.

| Project | Engine/profile | Viewport/device | Applicable result | Visual | Fallback and cleanup |
| --- | --- | --- | ---: | --- | --- |
| `responsive-chromium-desktop` | Chromium 151 | 1440×900 desktop | 13 successful, 1 intentional skip; one host-network retry in the combined run | Square/wide, light/dark, transparency, aspect, aura, clear space, no card overlap | Reduced motion, import/fetch/decode failure, context loss, privacy, disposal |
| `responsive-firefox-desktop` | Firefox 153 | 1440×900 desktop | 13 passed, 1 intentional skip | Same static visual contract | Actual no-WebGL path verified as static fallback with zero enhancement work; auth remains usable |
| `responsive-webkit-desktop` | WebKit 26.5 | 1440×900 desktop | 13 passed, 1 intentional skip | Same static visual contract | Reduced-motion teardown boundary and settled resource trace passed |
| `responsive-chromium-wide` | Chromium 151 | 2560×1440 desktop | 13 successful, 1 intentional skip in the combined run | Wide layout, square/wide sources, no overlap | Full eligible-desktop fallback, auth, privacy, and cleanup contract |
| `responsive-chromium-tablet` | Chromium 151, iPad Mini landscape profile | 1133×744 | 1 passed, 13 intentional skips | Personalized field correctly omitted | Login and registration operable; zero particle request/canvas |
| `responsive-chromium-mobile` | Chromium 151, Pixel 7 profile | 412×839 | 1 successful, 13 intentional skips | Personalized field correctly omitted | Login and registration operable; zero particle request/canvas |
| `responsive-webkit-mobile` | WebKit 26.5, iPhone 13 profile | 390×664 | 1 passed, 13 intentional skips | Personalized field correctly omitted | Login and registration operable; zero particle request/canvas |
| `responsive-webkit-mobile-landscape` | WebKit 26.5, iPhone 13 landscape | 844×390 | 1 passed, 13 intentional skips | Personalized field correctly omitted | Scrollable login and registration remain operable; zero enhancement work |
| `responsive-chromium-desktop` | Google Chrome 152.0.7977.82 | 1440×900 desktop | 13 successful, 1 intentional skip; one host-network retry | Full desktop visual contract | Full fallback, privacy, authentication, and cleanup contract |

## Visual and interaction evidence

| Contract | Result |
| --- | --- |
| Square and 12:1 wide inputs | Passed in light and dark themes with preserved source aspect and at least 8% field clear space |
| Transparency and identity | Transparent corner alpha retained; opaque coverage and source black, white, and blue color populations retained |
| Aura | Configured square aura resolved to `rgb(51 102 153 / 8%)`; unconfigured wide aura remained transparent |
| Composition | Decorative field is a sibling after the login card, never intersects the card, and is absent below eligibility or with no measured free space |
| Accessibility | Landmark, heading, textbox and button names, title, tab order, focus geometry, and enabled authentication controls match the unmanaged baseline |
| Pointer behavior | Bounded, stroke-scaled response passed; no pointer coordinates or telemetry left the page |
| Reduced motion at startup | Personalized static artifact rendered before mount; zero scene import, particle fetch, WebGL context, canvas, timer, RAF, idle callback, or pointer listener |
| Reduced motion at runtime | Static opacity changed synchronously, canvas was removed, active work reached zero, and callback/resource counters did not advance after the teardown boundary |
| Loading failures | Import, particle fetch, and decode failures settled to personalized static output without reattempt loops; corrupt static output settled to the shared ordinary logo |
| GPU failure | WebGL context loss synchronously restored static output, preserved authentication focus, and disposed active resources |
| Visibility and layout lifecycle | Hidden and offscreen two-second windows produced zero callbacks; hard-ineligible 959px layout produced zero canvas; no late callbacks or leaked timers, RAFs, idle callbacks, or pointer listeners |
| Privacy | Particle fetch resolved with `credentials: omit`; request headers contained no particle cookie; every request remained same-origin; pointer movement generated no request |

## Performance and resource budgets

### Runtime renderer

Measured in Chromium 151 at 1440×900, device scale factor 1.5, over 20 cold runs:

| Metric | Result | Budget |
| --- | ---: | ---: |
| First rendered frame p95 | 471.6 ms | ≤ 1500 ms |
| Frame interval p95 | 16.8 ms | ≤ 20 ms |
| Frame interval p99 | 17.1 ms | ≤ 34 ms |
| Callback CPU p95 | 0.1 ms | ≤ 2 ms |
| Cold-run timeouts | 0 | 0 |
| Hidden/offscreen callback count over 2 s | 0 / 0 | 0 / 0 |

### Production bundles

| Closure | Raw | Gzip | Budget |
| --- | ---: | ---: | ---: |
| Login direct JavaScript | 36,426 B | 9,906 B | 10.7 KiB gzip |
| Login direct CSS | 10,865 B | 2,233 B | 4 KiB gzip |
| Initial login scene/Tres/Three/shader/particle assets | 0 B | 0 B | 0 B |
| Lazy particle scene closure | 854,432 B | 227,174 B | 950 KiB raw / 260 KiB gzip |

Largest-chunk and aggregate JavaScript budgets also passed: 992.2 KiB of 1400 KiB and 11,412.1 KiB of 12,288 KiB respectively.

### Exact release image preprocessing

The exact runtime image used Bun 1.4.0, Sharp 0.35.4, libvips 8.18.6, and processing concurrency 1. The three-case corpus completed in 14,520.18 ms with no threshold violations.

| Corpus case | Outcome | p95 time | p95 peak RSS delta |
| --- | --- | ---: | ---: |
| Accepted opaque PNG badge | Accepted | 4,857.26 ms | 128,458,752 B |
| Malformed truncated PNG | Rejected `INVALID_IMAGE` | 0.213 ms | 0 B |
| 4097×4095 decompression-bomb PNG | Rejected `INVALID_IMAGE` | 56.37 ms | 103,235,584 B |

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

The corrected image was promoted to Docker container `wiki-tailnet` on `wiki-pg-migration-net`, bound to `127.0.0.1:3014`, and reported `running healthy`. Tailnet HTTPS continues to proxy port 10443 to that local binding. Local and tailnet `/healthz` returned `200 {"ok":true}`; local and tailnet `/login` returned `200 text/html`. Anonymous `/_api/site/logo` returned 403 before body handling, and a malformed public logo object returned 404.

A real browser opened the deployed tailnet URL with title `Login | Tim O'Pedia`: the login card, email field, password field, enabled Log In button, and existing `/topedialogo23.png` logo were visible. The live database has no active managed-logo revision; the rejected pipeline-v1 candidate remains failed and unactivated, so the legacy logo and zero personalized particle fields are the correct fallback. Deployment verification did not mutate branding.

The exact rejected 13,151-byte, 481×481 transparent PNG (`sha256:5ecad39758dc6fe9e357c04a0b22728f3d96d54ad8bc4374e22b39a44e257b16`) was processed inside the final image. Pipeline v2 accepted it as a 447×479 normalized logo with 9,346 particles, 62.0967-pixel median stroke, and `#f9a134` aura; outputs were 13,125-byte ordinary PNG, 112,208-byte particle-v1, and 92,787-byte static-effect PNG. The correction scales only reconstructed particle core footprints by the normalized long-axis ratio used by the runtime renderer; the encoded particle data and 0.90 overlap gate remain unchanged.

Rollback containers retained, stopped: `wiki-tailnet-rollback-e6d10411` and `wiki-tailnet-rollback-16fa062`.
