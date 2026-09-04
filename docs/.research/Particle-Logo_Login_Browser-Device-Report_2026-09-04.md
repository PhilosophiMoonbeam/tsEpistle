# Particle Login Logo Browser and Device Report — 2026-09-04

## Release identity

- Runtime source/threat binding: `55f30709cd4b8de0ec1fd498cac7174f1cacd084`
- Deployed image: `tsepistle:844427c3`
- Deployed image revision: `844427c3cf19e5c89b3c119830ae220e1f90eca7`
- Image ID: `sha256:f28b04297647cd2af4ead68c5462276b28a1f5ee1570a9bd5845f22e23df3258`
- Final repository evidence head (later test/docs evidence): `aef4b2d3a1730243fb55349d6bb1db0e37da2709`
- Playwright: 1.62.1
- Bundled engines: Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5
- Installed distribution check: Google Chrome 152.0.7977.82
- Deployed surface: `https://agents8c48g.tail41a24a.ts.net:10443/login`
- Active managed-logo revision: `6b3d846a-0c38-495f-a72b-e4fd4d871e42`, pipeline 4, state generation 7

The runtime source/threat binding, deployed image revision, and later repository evidence
head are recorded separately; the later head does not identify the runtime image.

## Executed release rows

The 120-row responsive run was not fully green: 58 rows passed, 60 were explicit
capability skips, and two initially non-passing or intermediate outcomes were corrected
rather than counted as clean final rows. WebKit's delayed regional ratio exposed an
invalid arbitrary `1.15` test multiplier; that multiplier was fixed and the targeted
WebKit run then passed without retry. One Chromium asset-load transient recovered under
the configured retry, and its exact test passed later without retry. No terminal failure
remained.

The exact production performance run passed 1/1, and targeted Chromium and WebKit
fixed-time motion runs passed independently. The final browser/device evidence was:

| Project | Engine/profile | Viewport/device | Result and scope |
| --- | --- | --- | --- |
| `responsive-chromium-desktop` | Chromium 151 | 1440×900 desktop | 13 direct passes, 1 retry-recovered asset-load transient, 1 intentional skip; the exact transient case later passed without retry |
| `responsive-firefox-desktop` | Firefox 153 | 1440×900 desktop | 14 successful, 1 intentional skip; ordinary visual contract and actual no-WebGL fallback |
| `responsive-webkit-desktop` | WebKit 26.5 | 1440×900 desktop | 13 initial passes, 1 invalid regional-ratio assertion corrected and then passed without retry, 1 intentional skip |
| `responsive-chromium-wide` | Chromium 151 | 2560×1440 desktop | Desktop eligibility, motion locality, fallback, privacy, authentication, and cleanup |
| `responsive-chromium-tablet` | Chromium 151, iPad Mini landscape profile | 1133×744 | 1 passed, 14 capability skips; no personalized field, login and registration operable |
| `responsive-chromium-mobile` | Chromium 151, Pixel 7 profile | 412×839 | 1 successful, 14 capability skips; no personalized field, login and registration operable |
| `responsive-webkit-mobile` | WebKit 26.5, iPhone 13 profile | 390×664 | 1 passed, 14 capability skips; login and registration operable |
| `responsive-webkit-mobile-landscape` | WebKit 26.5, iPhone 13 landscape | 844×390 | 1 passed, 14 capability skips; scrollable login and registration operable |
| `responsive-chromium-desktop` | Google Chrome 152.0.7977.82 | 1440×900 desktop | Distribution run retained from the release evidence |

## Visual and interaction evidence

| Contract | Result |
| --- | --- |
| Ordinary logo identity | The decoded, auto-oriented sRGB RGBA upload remains the canonical ordinary artifact; effect processing does not mutate it. |
| Density and reconstruction | Pipeline v4 generates `1000..4000` particles with IoU `>=0.75` and four deterministic reserves per component. The live count is 2,337 versus the prior 4,673 (50.0% within rounding), with visible individual gaps. The runtime uses a separate fixed four-slot impulse-uniform ring, and the parser retains a 16,000-record cap. |
| Motion model | Input above 2 px activates a circular core and a fixed 12 px segment cap with an 8 px aggregate cap. A delayed `0.18` outward annulus reaches `2.1R`; an analytic damped spring is active for 240 ms and settled by 900 ms. Particle life is 0.9 s. There is no dynamic geometry or CPU particle loop. |
| Cursor behavior | A 6 px pointer segment produced no long blade or gash. Immediate, 1000 ms, and another 1200 ms frames showed the intrinsic dark vertical stem; by 1000 ms the shape was back within the ongoing floating baseline, with discrete gaps preserved. |
| Aura | The active generated aura is `#f9a134`; an absent configured aura remains transparent. |
| Composition | Decorative field is a sibling after the login card, never intersects the card, and is absent below eligibility or with no measured free space. |
| Accessibility | Landmark, heading, textbox and button names, title, tab order, focus geometry, and enabled authentication controls match the unmanaged baseline. |
| Reduced motion at startup | Personalized static artifact rendered before mount; zero scene import, particle fetch, WebGL context, canvas, timer, RAF, idle callback, or pointer listener. |
| Reduced motion at runtime | Static opacity changed synchronously, canvas was removed, active work reached zero, and callback/resource counters did not advance after the teardown boundary. |
| Loading and GPU failures | Import, fetch, decode, corrupt-static, and context-loss paths settled to faithful static or ordinary output without loops while preserving authentication focus. |
| Visibility and layout lifecycle | Hidden and offscreen windows produced zero callbacks; hard-ineligible layout produced zero canvas; no late callbacks or leaked timers, RAFs, idle callbacks, or pointer listeners. |
| Privacy | Particle fetch used `credentials: omit`; requests contained no particle cookie and remained same-origin; pointer movement generated no request or telemetry. |

## Performance and resource budgets

### Runtime renderer

Measured against the deployed runtime in Chromium 151 at 1440×900, device scale
factor 1.5, using 20 cold isolated contexts. The non-retriable fully active 10 s
input window used 50 six-pixel segments plus four prime segments.

| Metric | Result | Budget or threshold |
| --- | ---: | --- |
| First rendered frame p95 | 444.5 ms | ≤ 1500 ms |
| Fully active frame intervals | 599 over 9,982.9 ms | ≥250 intervals spanning ≥9000 ms |
| Frame interval p95 / p99 | 16.9 ms / 17.1 ms | ≤20 ms / ≤34 ms |
| Callback CPU p95 | 0.1 ms | ≤2 ms |
| Cold-run timeouts | 0 | 0 |
| Active impulses / callbacks | 4 / 1,200 | Recorded in the non-retriable 10 s input window |
| Hidden/offscreen callbacks | 0 / 0 | 0 / 0 |
| Input and travel diagnostics | 50 six-pixel segments plus four prime segments; max travel 8; neighbor 0.18 | Fixed-time active-input coverage |

### Production bundles

| Closure | Result | Budget |
| --- | ---: | ---: |
| Login direct JavaScript | 36,426 B raw / 9,906 B gzip | Release budget passed |
| Lazy particle scene closure | 860,705 B raw / 229,105 B gzip | Release budget passed |
| Initial particle closure | 0 B | 0 B |

Largest-chunk and aggregate JavaScript budgets passed in the final image build.

### Active artifacts

The source artifact is 13,151 B, 481×481, with SHA-256
`5ecad39758dc6fe9e357c04a0b22728f3d96d54ad8bc4374e22b39a44e257b16`. The production
artifacts were generated and atomically activated:

| Artifact | Result |
| --- | --- |
| Canonical ordinary PNG | 11,009 B; unchanged SHA-256 `445c0a2a3d818fd27ab0efc6e31887a6903e331efe5868a0f82f9337781ba662` |
| Particle artifact | 447×479; 2,337 records; 28,100 B raw / 16,143 B gzip; SHA-256 `07d3764fde49f5ecd2a2f6cbf8b7477a00bf75c0827ef7982833278883e9b6d6`; `TSEP` v1 flags 7; CRC `1895907205` matches computed |
| Static effect PNG | 74,986 B; SHA-256 `ecfad0ee14e96954ab9aa47e33cbad79d03db86e09626daee437f189abf3a5a5` |
| Aura | `#f9a134` |

## Release-time browserslist accountability

No target below is inferred from another target. “Unexecuted” means the named browser
distribution was not installed on this Linux workstation; engine-profile coverage above
is supporting evidence, not a claim of distribution equivalence.

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

The pre-compatibility image `48c96e7e` was fully stopped and retained as
`wiki-tailnet-rollback-48c96e7e`. The capability-only `@1` commit `2e0` was deployed
fleet-wide, then stopped and retained as `wiki-tailnet-rollback-2e0cd7c8`.

The final image `tsepistle:844427c3` runs on `wiki-tailnet`, port 3014, network
`wiki-pg-migration-net`, with restart policy `unless-stopped`. It reports `running
healthy`, and local plus tailnet `/healthz` return `200 {"ok":true}`. Only then was
the `@2` v4 job `0c57ef54-4bcb-43a7-80e5-c23b4605d525` enqueued; it succeeded on
attempt 1 with no error. The runtime restarted once after atomic activation.

A real browser opened the deployed tailnet URL with title `Login | Tim O'Pedia`. The
raw harness profile without fine-hover capability correctly selected ordinary fallback.
The same real tailnet page, with desktop fine-hover media emulation and no asset or
descriptor mocks, loaded one live 705.625×688.8125 canvas and the exact v4 descriptor
and revision with 2,337 records. The pointer and timed-frame evidence above came from
that live surface.

Verification covered 374/374 isolated test files. Full `ci:static` passed all named gates
after the license inventory refresh. Exact production performance passed 1/1, and
targeted Chromium and WebKit fixed-time motion passed. Correctness review reported no
findings. A medium security rollout-document finding was corrected and its closure
reported no findings. A performance stalled-loop gate finding was corrected with
coverage thresholds and its closure reported no findings. Trace review also found and
fixed a redundant CDP cache mutation causing `net::ERR_NETWORK_CHANGED` and a Tres
pause/disconnect race.

Additional stopped rollback containers remain available:
`wiki-tailnet-rollback-e6d10411`, `wiki-tailnet-rollback-16fa062`,
`wiki-tailnet-rollback-c4fc3713`, `wiki-tailnet-rollback-48c96e7e`, and
`wiki-tailnet-rollback-2e0cd7c8`.
