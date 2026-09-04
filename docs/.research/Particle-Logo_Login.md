# tsEpistle Login Particle Treatment Implementation Plan

## 1. Decision and non-goals

### Decision

Implement a desktop-only **Indigo Signal Field**: a particle rendering of the canonical 332:88 tsEpistle wordmark in the open grid field to the right of the login card.

The field is fixed tsEpistle product decoration. It does not replace tenant identity. The runtime-configured 34 px logo and site title in `.login-brand` remain unchanged, visible, and authoritative in every state.

Use Vue 3 and TresJS 5 to render one immutable `THREE.Points` dataset with one orthographic camera and one custom `ShaderMaterial`. Generate one binary dataset before Vite builds the client. Whenever the decorative host is rendered, keep the static SVG beneath the transparent canvas.

### Fixed scope

- Silhouette width `W`: `clamp(16rem, 28vw, 24rem)`.
- Wrapper footprint: width `1.2W`; height `1.2W × 88 / 332`.
- Aspect ratio: `332 / 88`.
- Particle count: 12,000.
- DPR: 1 to 1.5, capped at 1.5.
- Interaction: primary fine mouse or pen only.
- Rendering states: `omitted | static → loading → ready`; failures use the visible `static` fallback.
- Authentication logic and state never import or await the scene module and never read or write particle state.

### Non-goals

- Replacing `.login-brand`, `siteConfig.logoUrl`, `siteConfig.title`, or `#login-site-title`.
- Rendering arbitrary tenant logos or accepting a runtime asset URL.
- Mobile, touch, coarse-pointer, short-viewport, reduced-motion, or undersized-field animation.
- Physics, CPU particle simulation, assembly or explosion effects, cursor chase, global pulse, rotation, sound, bloom, additive blending, post-processing, or perspective.
- Multiple datasets, quality tiers, palettes, theme-mutated colors, configuration props, or a public particle API.
- Authentication telemetry, pointer telemetry, third-party requests, retries, or fallback messages.

## 2. Repository ground truth

- `client/components/login.vue` is a Pug-template Options API component. `.login` is a full-viewport flex layout; `main.login-sd` is at most 30 rem wide.
- `.login-brand` contains a 3.25 rem tile and a 34 px runtime-configured image. The source wordmark cannot be made legible there without disrupting every authentication flow.
- `.login::after` already exposes a masked grid after 38% of the viewport, and `.login::before` places an indigo spectral wash in the right field. The new field belongs in that space as a sibling of `main.login-sd`.
- Existing layout cutovers are 599 px for mobile and 650 px for short desktop viewports. Existing reduced-motion CSS only shortens CSS animation; it cannot stop WebGL.
- `client/static/svg/logo-tsepistle.svg` has a 332×88 viewBox, gradients, translucent strokes, six relevant brand colors, and three host-font-dependent `<text>` nodes.
- `package.json` currently pins Vue 3.5.41, Vite 8.2.1, Vuetify 4.1.9, `@vitejs/plugin-vue` 6.0.8, and TypeScript 6.0.2. TresJS, Three.js, Three.js types, and an SVG rasterizer are not installed.
- `vite.config.mts` maps `@` to `client`, uses `client/static` as `publicDir`, sets the production base to `/_assets/`, disables Vue template asset URL transformation, empties `assets/`, and emits hashed imported assets.
- `server/scripts/check-bundle-budgets.ts` measures manifest-reachable initial files, the largest JavaScript chunk, and all JavaScript. The verified pre-feature baseline passes at 267.1 KiB gzip for initial application JavaScript, 992.2 KiB raw for the largest JavaScript chunk, and 10,560.2 KiB raw of the 12,288 KiB all-JavaScript limit. It does not yet identify the particle lazy chunk or binary.
- The repository browser policy is `> 1%`, the last two major versions, and Firefox ESR, excluding IE, Android Browser, and dead browsers. Existing responsive projects cover desktop Chromium, Firefox, WebKit, wide Chromium, tablet, Pixel 7, and iPhone 13 layouts.

## 3. Visual composition

Render the field as a decorative sibling immediately after `main.login-sd` inside `.login`. Do not place it inside `main`, `.login-brand`, a form, or a dialog.

At each layout measurement, define the physical free-space rectangle `F` inside the `.login` padding box: `F.left = card.right + 2rem`, `F.right = paddingBox.right`, `F.top = paddingBox.top`, and `F.bottom = paddingBox.bottom`. Set the wrapper center to `((F.left + F.right) / 2, (F.top + F.bottom) / 2)`; do not position it from a viewport percentage. The card and wrapper rectangles must not intersect.

- Treat `W = clamp(16rem, 28vw, 24rem)` as the wordmark silhouette width. The silhouette height is `W × 88 / 332`.
- Reserve exactly 10% of `W` on the left and right and 10% of the silhouette height above and below. The clipped wrapper is therefore `1.2W × (1.2W × 88 / 332)`. At the minimum it is 19.2 rem × 5.0892 rem.
- Enter `omitted` unless `F` contains that entire wrapper. Approved 16, 20, and 24 rem captures use wrapper widths 19.2, 24, and 28.8 rem respectively.
- For normalized packed seed `s`, ambient motion is a positional circle with period `9 + 2s` seconds, phase `2πs`, and radius `1.5 × (0.25 + 0.75s)` CSS px. It changes neither size nor opacity, so there is no synchronized pulse.
- Fine-pointer effects are zero outside a radius equal to 12% of `W`. Inside it, the combined radial displacement and directional wake are clamped to 8 CSS px; the wake term is additionally capped at 2 CSS px. There is no whole-group parallax. Influence falls below 1% within 800 ms after leave, cancel, or inactivity.
- Use `#6366F1`, `#4338CA`, `#4F46E5`, `#172033`, `#FFFFFF`, and `#C7D2FE`. Preserve source alpha. Use normal alpha blending only.
- Behind the SVG and canvas, use one circular radial gradient centered at `50% 50%` of the wrapper: `var(--wiki-accent-spectral)` at 12% opacity at radius 0, 6% at radius 45%, and transparent at radius 70% and beyond. The gradient is transparent over the existing login grid/background; do not add a solid wrapper color or fill that hides the grid. These existing tokens are the only wash colors; the wash never changes packed RGB or provides control contrast.
- The SVG is present at opacity 1 in `static` and `loading`. In `ready`, the canvas fades to opacity 1 over 180 ms while the SVG remains beneath it; the SVG becomes opacity 0 only after the first rendered particle frame. A scene failure restores SVG opacity synchronously. `omitted` renders no wrapper, SVG, or canvas.

## 4. Dependency and file map

### Version decision

Pin these development dependencies exactly during implementation:

- `@tresjs/core` 5.8.3
- `three` 0.184.0
- `@types/three` 0.184.1
- `@resvg/resvg-js` 2.6.2

This is a source-verified version alignment, not a claim that the latest releases are compatible: the published `@tresjs/core` 5.8.3 metadata lists development dependencies on Vite `^8.0.16`, Three.js `^0.184.0`, and `@types/three` `^0.184.1`. Its published Three.js peer range is the broader `>=0.133`; that range alone is not evidence that every matching release is compatible. Three.js 0.185.1 and `@types/three` 0.185.4 are the current registry releases as verified on 2026-09-04 and are intentionally not selected without a focused compatibility run.

Run the repository dependency-policy and license review for the rasterizer and native package before accepting the implementation. Do not add Cientos, a GLSL plugin, physics, or post-processing packages.

### Vite integration

Update `vite.config.mts` to import `templateCompilerOptions` from `@tresjs/core` and merge it into the existing `vue(...)` options without dropping `template.transformAssetUrls: false`. This compiler configuration is required for Tres custom-renderer elements.

Use Vite-native imports:

- `import datasetUrl from './logo-tsepistle.particles.bin?url'`
- `import vertexShader from './particle.vert.glsl?raw'`
- `import fragmentShader from './particle.frag.glsl?raw'`

No asset or shader plugin is required. Use `/_assets/svg/logo-tsepistle.svg` as the stable public SVG URL in development and production; do not use `import.meta.env.BASE_URL` or Pug asset rewriting. This build-owned public underlay is the sole content-hash exception.

### Owned files

| Path | Ownership |
|---|---|
| `client/components/login.vue` | Register the lightweight host, add the sibling, and add layout CSS only. Keep all auth data, computed values, watchers, lifecycle, methods, forms, dialogs, and `.login-brand` behavior unchanged. |
| `client/components/login-logo/LoginParticleLogo.vue` | Stable SVG URL, hard eligibility gates, host-lifetime observers, async scene import, state machine, pointer input, opacity, and fallback. It has no static TresJS or Three.js import. |
| `client/components/login-logo/LogoParticleScene.vue` | TresCanvas, WebGL2 check, binary fetch/parse, camera, geometry, material, points, uniforms, first-frame/error events, loop control, and epoch/GPU cleanup. |
| `client/components/login-logo/particle-logo.ts` | Fixed constants, binary parser, types, and coordinate helpers. |
| `client/components/login-logo/useLogoPointer.ts` | Fine-pointer normalization, velocity filtering, inactivity, and reset. |
| `client/components/login-logo/particle.vert.glsl` | Immutable-attribute displacement and point sizing. |
| `client/components/login-logo/particle.frag.glsl` | Circular point mask, source alpha, linear-space color, and normal blending output. |
| `client/components/login-logo/logo-tsepistle.particles.bin` | The only generated runtime dataset, imported with `?url`. |
| `client/static/svg/logo-tsepistle.svg` | Canonical generator input and static underlay. |
| `server/scripts/generate-particle-logo.ts` | Deterministic rasterization, sampling, packing, checksum, and check mode. |
| `server/scripts/check-bundle-budgets.ts` | Particle-specific initial, lazy-JS, and binary budget enforcement. |
| `package.json` | Exact dependencies and a pre-Vite generation/check step. |

## 5. Deterministic source and generator pipeline

1. Convert the three `<text>` elements in `client/static/svg/logo-tsepistle.svg` to committed path data. Reject `<text>`, external references, scripts, animation, and remote URLs. This removes host-font variance.
2. With `@resvg/resvg-js` 2.6.2, render the 332:88 SVG at exactly 1328×352 pixels on a transparent background and set the Resvg `font` option to `{ loadSystemFonts: false }`. Read RGBA bytes directly from `RenderedImage.pixels`; do not encode or decode PNG. Resvg makes no sRGB or reproducibility guarantee here: byte reproducibility is a repository contract enforced by the clean-run check below.
3. Iterate pixels in row-major order, `y = 0..351`, then `x = 0..1327`. Let `A(x,y)` be the alpha byte, or zero outside the raster, and retain candidates with `A ≥ 16`. Apply the standard Sobel kernels to alpha: `Gx = -A(x-1,y-1) + A(x+1,y-1) - 2A(x-1,y) + 2A(x+1,y) - A(x-1,y+1) + A(x+1,y+1)` and `Gy = -A(x-1,y-1) - 2A(x,y-1) - A(x+1,y-1) + A(x-1,y+1) + 2A(x,y+1) + A(x+1,y+1)`. Define `edge = min(1, hypot(Gx, Gy) / (1020√2))` and `weight = (A / 255) × (1 + 1.5 × edge)`.
4. For linear index `i = y × 1328 + x`, define exactly one 32-bit mixer with JavaScript unsigned-32 semantics: `function mix32(v) { let z = (v + 0x9E3779B9) >>> 0; z = Math.imul(z ^ (z >>> 16), 0x21F0AAAD) >>> 0; z = Math.imul(z ^ (z >>> 15), 0x735A2D97) >>> 0; return (z ^ (z >>> 15)) >>> 0; }`. Compute `sampleHash = mix32((0x54534550 + i) >>> 0)`, `u = (sampleHash + 0.5) / 4294967296`, and weighted-reservoir priority `k = -Math.log(u) / weight`. Use `sampleHash` only for this priority. Retain the 12,000 lowest priorities; break exact ties by `y`, then `x`.
5. `RenderedImage.pixels` is premultiplied RGBA. Before palette comparison, demultiply each nonzero-alpha channel byte `p` as `min(255, floor(p × 255 / A + 0.5))`; this is nearest-integer rounding with half ties upward. Interpret the resulting straight RGB triple as sRGB for conversion to OKLab, select the nearest §3 palette color, break equal distances by palette order, and preserve the original alpha byte.
6. Define `round0(v) = sign(v) × floor(abs(v) + 0.5)`. Quantize pixel centers as `qx = round0((2 × (x + 0.5) / 1328 - 1) × 32767)` and `qy = round0((1 - 2 × (y + 0.5) / 352) × 32767)`. Domain-separate particle attributes from sampling and from one another with `depthHash = mix32((0x44455054 + i) >>> 0)`, `sizeHash = mix32((0x53495A45 + i) >>> 0)`, and `seedHash = mix32((0x53454544 + i) >>> 0)`. Let `depthByte = depthHash & 255` and `sizeByte = sizeHash & 255`; pack depth `floor((254 × depthByte + 127) / 255) - 127`, size `1 + floor(255 × sizeByte / 256)`, and seed `seedHash >>> 16`. Never derive an attribute from `sampleHash`. These formulas produce depth `[-127,127]`, size `[1,255]`, and seed `[0,65535]` without prohibited sentinels.
7. For Morton sorting, map `ux = qx + 32767` and `uy = qy + 32767`, interleave their low 16 bits into one unsigned 32-bit code with `ux` bits in even positions and `uy` bits in odd positions, then sort by unsigned code, `y`, and `x`.
8. Pack §6 exactly and write only `client/components/login-logo/logo-tsepistle.particles.bin`. In `--check` mode, generate in memory, byte-compare with the committed file, and print SHA-256, count, dimensions, palette histogram, raw bytes, and gzip-9 bytes.
9. Run check mode and generation before `bun --bun vite build`. Never write generator output directly to `assets/`, because Vite empties that directory.

Two clean-checkout runs on the supported build platform must produce identical bytes and SHA-256. CI fails if byte comparison, the fixed count/dimensions/palette/alpha invariants, or the raw/gzip limits fail; the printed report is diagnostic output, not an untracked acceptance artifact.

## 6. Versioned packed binary contract and parser limits

All integers are little-endian. Version 1 is a 56-byte header followed by tightly packed structure-of-arrays blocks; it permits zero-copy typed-array views for GPU attributes.

### Header v1

| Offset | Type | Field | Required value |
|---:|---|---|---|
| 0 | `char[4]` | magic | ASCII `TSEP` |
| 4 | `uint16` | version | `1` |
| 6 | `uint16` | header bytes | `56` |
| 8 | `uint32` | particle count | generated value `12000`; parser range `1..16384` |
| 12 | `uint16` | intrinsic width | `332` |
| 14 | `uint16` | intrinsic height | `88` |
| 16 | `uint16` | layout id | `1` |
| 18 | `uint16` | flags | `0x0007`: sRGB color, Y-up coordinates, straight alpha |
| 20 | `uint32` | payload bytes | `12 × count` |
| 24 | `uint32` | payload CRC | CRC-32/ISO-HDLC over bytes `[56, fileBytes)` |
| 28 | `uint32` | XY offset | `56` |
| 32 | `uint32` | depth offset | `56 + 4 × count` |
| 36 | `uint32` | RGBA offset | `56 + 5 × count` |
| 40 | `uint32` | size offset | `56 + 9 × count` |
| 44 | `uint32` | seed offset | `56 + 10 × count` |
| 48 | `uint32` | file bytes | `56 + 12 × count` |
| 52 | `uint32` | reserved | `0` |

### Packed blocks

- XY: `Int16Array(count × 2)`, normalized; reconstruct `x = qx / 32767 × 0.5` and `y = qy / 32767 × (88 / 332) × 0.5`. `-32768` is invalid.
- Depth: `Int8Array(count)`, normalized; `-128` is invalid and the shader scales by 0.006.
- RGBA: `Uint8Array(count × 4)`, normalized palette sRGB with straight alpha. Alpha must be at least 16.
- Size: `Uint8Array(count)`; zero is invalid and multiplier is `0.75 + 0.75 × (size - 1) / 254`.
- Seed: `Uint16Array(count)`, normalized as `seed / 65535`.

The parser first requires an `ArrayBuffer` of at least 56 bytes. It then validates magic, known version/layout/flags, dimensions, reserved fields, count limits, checked offset arithmetic, exact offsets, exact payload and file lengths, block alignment, every prohibited sentinel/range, palette membership, CRC, and no trailing bytes. Maximum accepted input is 196,664 bytes (`56 + 12 × 16,384`). Validation precedes any geometry allocation.

Fetch only the statically imported `datasetUrl`; never construct or accept a runtime URL. In production, require its origin to equal `location.origin` and use `mode: 'same-origin'`. In development, require origin `http://127.0.0.1:5173`, where the import resolves to the build-owned `http://127.0.0.1:5173/client/components/login-logo/logo-tsepistle.particles.bin`, and use `mode: 'cors'`. In both modes use `credentials: 'omit'` and an `AbortSignal`; no other cross-origin URL is eligible. Require `response.ok`; reject an advertised or received body above 196,664 bytes. Any origin, CORS, fetch, read, or validation error emits one scene error and follows §8.

## 7. Vue and TresJS component ownership

`LoginParticleLogo.vue` is the only component imported synchronously by `client/components/login.vue`. It renders the eligible static host and creates the scene with `defineAsyncComponent({ loader: () => import('./LogoParticleScene.vue'), onError })`. `onError` calls `fail()` without retry and routes the import rejection to the current epoch's failure transition. Authentication rendering and strategy loading proceed independently.

Install a Vue `onErrorCaptured` boundary in `LoginParticleLogo.vue`. While an epoch is active, any descendant setup or render exception transitions that epoch to failure; the hook returns `false` after handling so the exception does not reach authentication. `LogoParticleScene.vue` imports TresJS, Three.js, shaders, and the binary URL and calls `WebGL.isWebGL2Available()` before mounting `TresCanvas`; WebGL 1 is not a degraded mode.

Use `TresCanvas` with transparent background, `clearAlpha=0`, `antialias=false`, DPR `[1, 1.5]`, and an active loop only while animation is allowed. Bind its declared `@error` only to TresJS renderer-manager and renderer-initialization failures. Its `ready` event supplies the renderer and native canvas. Before compiling material, set `renderer.debug.checkShaderErrors = true` and set `renderer.debug.onShaderError` to the epoch failure callback. Independently route async-import rejection through `defineAsyncComponent`, descendant setup/render exceptions through Vue error capture, shader errors through the debug hook, loop exceptions through the scene boundary, and context loss through the native canvas event.

Create `BufferGeometry`, normalized `BufferAttribute` views, `ShaderMaterial`, and `Points` once. Pass the points through `<primitive>`. Keep Three.js objects in `shallowRef`; do not make typed arrays deeply reactive. Because TresJS does not own raw primitive allocations, the scene explicitly disposes geometry and material.

Use `useLoop().onBeforeRender` to update only elapsed time, pointer, velocity, influence, CSS-to-model scale, and opacity uniforms. Wrap the callback body in `try/catch` and emit one epoch error on an exception. Never mutate or replace a `BufferAttribute` array after geometry creation.

Report readiness from `Points.onAfterRender` after a nonzero-size render and only if compilation produced no `onShaderError` callback. Emit `first-frame` once; the wrapper alone changes `loading` to `ready`.

## 8. Failure-first loading state machine

| State | Required behavior |
|---|---|
| `omitted` | A hard gate is false; render no decorative wrapper, SVG, canvas, scene import, dataset request, particle-loop callback, or pointer listener. Authentication is fully usable. |
| `static` | Hard gates pass; the wrapper and `/_assets/svg/logo-tsepistle.svg` are present and the SVG is visible; there is no canvas, renderer, dataset request, particle-loop callback, or pointer listener. |
| `loading` | Full load eligibility passed; the SVG stays visible while import, WebGL2 check, fetch, parse, compile, and first render run. The canvas is transparent and non-semantic. |
| `ready` | The first successful nonzero-size `Points.onAfterRender` occurred with no shader error; the canvas fades in and the SVG remains mounted beneath it. |

Hard-gate loss transitions any state to `omitted` and tears down the scene epoch. A hard-gate rising edge enters `static`. A full-load-eligibility rising edge enters `loading`; success enters `ready`. A failure enters `static`, tears down that epoch, and latches against retry until full load eligibility becomes false and later true. There are no retries within an epoch.

The wrapper records `epochStartedAt = performance.now()` on the `static → loading` transition and owns one timer with an absolute deadline of `epochStartedAt + 1,500 ms`. This single wall-clock deadline includes module import, WebGL2 check, fetch, parse, renderer/material setup, shader compile/link, and first render. `defineAsyncComponent` has no separate timeout. If `first-frame` is not accepted by the deadline, fail the epoch; a first frame arriving at or after the deadline is late. Release measurements allow zero timeout runs.

Return to `static` on:

- async component import rejection;
- a descendant setup/render exception captured by Vue;
- unsupported WebGL2;
- an invalid origin, CORS failure, non-2xx, oversized, unexpectedly aborted, or unreadable dataset response;
- any header, length, checksum, range, or palette parse failure;
- zero wrapper or drawing-buffer size at render;
- TresCanvas `@error` from its renderer manager, renderer creation/compilation/render exception, or `renderer.debug.onShaderError`;
- the 1,500 ms epoch deadline;
- native `webglcontextlost` after initialization; or
- an unexpected exception in a loop callback.

Register `webglcontextlost` directly on the canvas obtained from TresCanvas `ready`. On loss, synchronously restore the SVG, stop the loop, prevent further rendering, and run epoch teardown; do not attempt in-place restoration.

Every promise, callback, and event carries the epoch token. After teardown, it may release a local result but cannot mount, emit readiness, change opacity, start a loop, or alter authentication state.

## 9. Responsive orthographic, shader, and pointer contracts

### Eligibility and sizing

The following hard gates must all pass:

- viewport width at least 960 px;
- viewport height at least 651 px;
- `(hover: hover)` and `(pointer: fine)`;
- `(prefers-reduced-motion: no-preference)`; and
- the §3 free-space rectangle contains the complete wrapper for the current `W`, including its 10% padding on every side.

A hard-gate failure has exactly one outcome: `omitted`. Host-lifetime media listeners and a `ResizeObserver` on `.login` and `main.login-sd` recompute those gates without requiring the decorative wrapper to exist.

Full load eligibility additionally requires `document.hidden === false` and wrapper intersection of at least 10%. These are activity gates, not hard gates. Before readiness, an activity-gate loss cancels `loading` to `static`; its later false-to-true edge may start a new epoch. After readiness, activity-gate loss retains the mounted canvas but makes it inert as specified in §11.

### Orthographic fit

Model silhouette width is 1.0 and height is `88 / 332`. The fixed 10% padding on every side gives wrapper content width `1.2` and height `1.2 × 88 / 332`; CSS sizes the wrapper to `1.2W × (1.2W × 88 / 332)`, so the rendered silhouette is exactly `W`.

For drawing-buffer aspect `A = cssWidth / cssHeight`:

- `visibleHeight = max(contentHeight, contentWidth / A)`;
- `visibleWidth = visibleHeight × A`;
- frustum is `[-visibleWidth/2, +visibleWidth/2] × [-visibleHeight/2, +visibleHeight/2]`;
- camera near/far are `0.1/10` and position is `(0, 0, 2)`.

Update projection and `uCssPixelsPerModelUnit = cssWidth / visibleWidth` after each nonzero `ResizeObserver` result. Verify that the silhouette bounding box is `W × (W × 88 / 332)` within 0.5 CSS px and the 10% margins are not cropped.

### Shader contract

- Vertex shader reconstructs immutable XY/depth and applies only the §3 ambient circle and local pointer terms.
- For seed `s = packedSeed / 65535`, use exactly the §3 period, phase, and CSS-pixel radius, converted through `uCssPixelsPerModelUnit`. Point size and opacity have no time-only term.
- For local input, let `d` be distance from a particle's undisplaced XY to the pointer, `R = 0.12` model-width units, `q = clamp(1 - d / R, 0, 1)`, and falloff `f = q²(3 - 2q)`. Both radial and wake terms multiply `f`, are exactly zero at `d ≥ R`, and their vector sum is clamped to 8 CSS px; the wake term is capped at 2 CSS px. Apply no model-, points-, or camera-level pointer translation.
- Fragment shader converts square points to soft circles, discards alpha below 0.01, and uses straight source alpha.
- Packed palette RGB is sRGB. Convert it to linear before lighting-free interpolation/blending and apply the Three.js output color-space chunk exactly once. Use `NormalBlending`, `transparent=true`, `depthWrite=false`, and `depthTest=false`.
- No shader changes palette colors for theme contrast.

### Pointer coordinates

Attach the pointer listener to the bounded wrapper only while an active scene epoch can use it, never to `document`, canvas, card, or a form control. The canvas has `pointer-events: none`; the wrapper has `touch-action: auto`.

For a primary `mouse` or `pen` event inside wrapper rectangle `r`:

- `ndcX = 2 × (clientX - r.left) / r.width - 1`;
- `ndcY = 1 - 2 × (clientY - r.top) / r.height`;
- `objectX = ndcX × visibleWidth / 2`;
- `objectY = ndcY × visibleHeight / 2`.

Velocity is object-space delta divided by elapsed seconds, with elapsed clamped to `[1/240, 1/15]`, magnitude capped at 1.5 model widths/s, and exponential smoothing time constant 80 ms. Ignore non-primary, coarse, and all touch events. On leave, cancel, 100 ms inactivity, activity pause, or resume, clear velocity and decay influence as `exp(-t / 0.17s)`; at 800 ms it is below 1%.

## 10. Reduced motion, input, privacy, and accessibility

- Reduced motion is a hard gate. If enabled before load, enter `omitted`: create no decorative wrapper, SVG, scene import, request, renderer, pointer listener, or particle-loop callback. If enabled at runtime, synchronously unmount the scene and wrapper and enter `omitted`.
- Coarse-pointer and touch layouts also enter `omitted`. Do not attach interaction listeners, call `preventDefault`, capture pointers, or change scrolling.
- When present, the wrapper, SVG, and canvas are decorative: `aria-hidden="true"`; image `alt=""`; no role, focusability, live region, or tooltip. They do not change the accessibility name, tree order, or tab order.
- The wrapper cannot overlap the card, dialogs, validation messages, or focus rings and never receives keyboard handling.
- Load only build-owned assets. Lazy chunks and the binary must be content-hashed. The stable same-origin public underlay `/_assets/svg/logo-tsepistle.svg` is explicitly exempt from content hashing; accept no URL prop and perform no runtime SVG parsing.
- In production all particle requests are same-origin. In development only the configured Vite origin in §6 is allowed, with CORS and omitted credentials. Pointer coordinates and timing remain local: do not log, persist, emit, aggregate, or transmit them.
- The particle subsystem reads no username, strategy, auth status, token, route query, form event, or site configuration.

## 11. Lifecycle and cleanup

`LoginParticleLogo.vue` has two lifetimes:

- **Host lifetime:** media-query and visibility listeners, a free-space `ResizeObserver`, and an `IntersectionObserver` instance. These monitors survive scene success, failure, activity pauses, and hard-gate transitions. The intersection observer observes each eligible wrapper when mounted and unobserves it when removed; only host unmount removes the listeners and disconnects both observers.
- **Scene epoch:** async component, deadline and pointer-inactivity timers, wrapper pointer listener, abort controller, canvas context-loss listener, Tres loop subscription, geometry, material, points callbacks, renderer hooks, and shallow refs.

When a `ready` scene becomes hidden or intersects below 10%, retain its canvas and GPU objects but call `useLoop().stop()` once, remove the pointer listener, and require zero particle-loop callbacks until activity returns. Resume the same epoch with `useLoop().start()` only while hard gates still pass and state is `ready`; restore the pointer listener and reset elapsed baseline, velocity, and influence before starting. Hard-gate loss never uses this pause path: it unmounts the canvas and enters `omitted`.

One idempotent scene-epoch teardown, used for pre-ready activity loss, unmount, hard-gate loss, failure, and context loss, must:

1. mark the epoch inactive, synchronously restore SVG opacity when entering `static`, and select `static` or `omitted` from current hard gates;
2. clear the epoch deadline and pointer-inactivity timer;
3. remove the epoch pointer listener;
4. stop and unsubscribe the loop;
5. abort the dataset fetch;
6. remove the native context listener and renderer shader-error hook;
7. clear `Points.onAfterRender` and detach the primitive;
8. call `BufferGeometry.dispose()` and `ShaderMaterial.dispose()` exactly once;
9. unmount TresCanvas, whose owned `WebGLRenderer.dispose()` must run exactly once and remove its canvas; and
10. release all epoch shallow refs.

Host unmount first runs epoch teardown, then removes host listeners, unobserves targets, and disconnects both observers. Late completions check the inactive token and perform no state transition. Repeated teardown calls are no-ops.

## 12. Provisional release budgets

These are explicit release gates from the first implementation. They are **provisional until measured** on the first production build; changing one requires a recorded baseline, reason, and review before merge.

| Measure | Provisional limit | Measurement |
|---|---:|---|
| Initial login JavaScript delta | ≤ 5 KiB gzip | Production manifest closure before/after; excludes async particle chunks. |
| Initial login CSS delta | ≤ 2 KiB gzip | Production manifest closure before/after. |
| Initial renderer content | 0 bytes | No TresJS, Three.js, shader, or binary module in the initial login closure. |
| Lazy particle JavaScript | ≤ 950 KiB raw and ≤ 260 KiB gzip-9 | Sum all chunks reachable only from `LogoParticleScene.vue`. |
| Dataset | exactly 144,056 raw bytes and provisional ≤ 112 KiB gzip-9 | Header plus 12,000 × 12 bytes; depth, size, and seed alone contribute 48,000 bytes of deliberately high-entropy data before positions and colors; generator report and emitted asset. |
| First frame | nearest-rank p95 ≤ 1,500 ms; 0 timeouts | For 20 cold-cache runs at 1440×900, measure §8 `epochStartedAt` to accepted `first-frame`, sort ascending, and use item `ceil(0.95 × 20) = 19`. Any timeout fails separately and is neither excluded nor substituted. |
| Animated frame interval | p95 ≤ 20 ms and p99 ≤ 34 ms | 10 s sample after 2 s warm-up, DPR 1.5, 1440×900, visible field. |
| Particle loop callback CPU time | p95 ≤ 2 ms | `onBeforeRender` instrumentation over the same sample. |
| Ready but hidden/offscreen | 0 particle-loop callbacks in 2 s; exactly 1 retained canvas in the particle wrapper | Exercise `document.hidden` and intersection below 10% after `ready`. |
| Hard-ineligible work | 0 particle-loop callbacks in 2 s; 0 canvases in the particle host | Reduced motion, coarse pointer, short/mobile viewport, and insufficient §3 free space; state is `omitted`. |

Use the repository workstation class as the initial performance floor: AMD Ryzen 7 5700G with integrated Radeon Vega graphics. The dated browser report must include exact browser, engine, and OS version strings for the current and previous major Google Chrome, Mozilla Firefox, and Apple Safari, plus the current Firefox ESR. Attach the exact release-time `browserslist` resolution and give every resolved desktop target a result row; no policy target may be inferred from another product, engine, or major. Repository Chromium, Firefox, and WebKit project results are supplementary evidence and do not replace those rows. Hardware frame thresholds apply to the named reference projects; all policy rows must pass behavior, fallback, layout, and cleanup checks. Extend `server/scripts/check-bundle-budgets.ts` to enforce initial deltas, lazy raw/gzip totals, and dataset raw/gzip totals while retaining existing global limits.

## 13. Phased implementation sequence

1. **Source and build contract:** outline SVG text; add exact dependencies; merge TresJS `templateCompilerOptions`; add generation/check scripts before Vite; implement the binary generator and parser fixtures.
2. **Static composition:** add `LoginParticleLogo.vue` and the sibling layout with the stable public SVG underlay; approve light/dark captures at 16, 20, and 24 rem silhouette widths in 19.2, 24, and 28.8 rem wrappers before enabling WebGL.
3. **Non-interactive renderer:** implement hard-gate omission, WebGL2 gating, async scene import, binary loading, immutable geometry, orthographic fitting, shaders, first-frame commit, and all named failure boundaries.
4. **Motion and input:** add fixed ambient motion, local fine-pointer response without group parallax, activity pause/resume, and runtime eligibility transitions. Add no tuning props.
5. **Integration hardening:** exercise every login screen and dialog while delaying or failing the particle subsystem; complete context-loss handling, idempotent teardown, browser coverage, and accessibility checks.
6. **Budget closure:** measure the production build and reference device, add particle-specific budget enforcement, record results, and resolve every provisional limit before merge.

Each phase leaves `.login-brand` and authentication behavior unchanged. A later phase cannot waive an earlier failure or static-fallback contract.

## 14. Verification matrix

| Area | Required verification and pass condition |
|---|---|
| Source determinism | Two clean generator runs have identical SHA-256 and bytes; binary reports 12,000 particles, 332×88, 144,056 bytes, only the six colors, and alpha ≥ 16. Known-answer fixtures cover the exact `mix32` steps, all four salted hashes, sample-only priority, independently derived depth/size/seed, and rounding formulas; they also verify that retained-particle attributes equal their direct attribute-hash results rather than any value derived from reservoir priority, and that translucent pixels are demultiplied before palette mapping. |
| Parser limits | Unit cases reject every header field mismatch, unknown flag/version/layout, count 0/16,385, overflowed offset, wrong alignment/length/CRC, trailing byte, `-32768`/`-128`, zero size, low alpha, and non-palette RGB before geometry allocation. |
| Visual identity | Approved light/dark screenshots at 16/20/24 rem silhouette widths in 19.2/24/28.8 rem wrappers show a recognizable full wordmark, exact 10% margins, every palette region, normal blending, the specified token wash, and the SVG before first frame. |
| Layout gates | At 959 px width, 650 px height, coarse pointer, reduced motion, or insufficient §3 free space, assert `omitted` and no wrapper, SVG, or canvas. At 960×651, loading starts only if the measured 2 rem gutter and complete 19.2 rem × 5.0892 rem minimum wrapper fit and activity gates pass; the wrapper center equals the center of `F` within 0.5 CSS px. |
| Camera | Resize captures preserve 332:88 geometry without crop or stretch; silhouette dimensions, margins, and computed frustum match §9 within 0.5 CSS px. |
| Pointer | Against an identical no-input frame, scripted primary mouse/pen input changes no particle at or beyond the 12%-width radius, has no whole-group translation, keeps combined local displacement ≤8 px and wake ≤2 px, and has <1% influence by 800 ms. Touch creates no wrapper, listener, or canvas. |
| Motion | Across 600 frames, attribute identities, bytes, versions, and `needsUpdate` remain unchanged; only documented uniforms change. Sample seed extrema and midpoint to verify 9–11 s periods, ≤1.5 px ambient radius, constant point size/opacity, and no synchronized pulse. |
| Loading independence | With lazy import and dataset each delayed beyond the 1,500 ms epoch deadline and then rejected, strategy selection, fields, submit, validation, forgot/reset/change-password, email verification, success, and TFA dialogs remain usable and above the decoration. |
| Failure fallback | Import rejection, Vue-captured setup/render throw, unsupported WebGL2, disallowed origin/CORS/HTTP error, oversized/truncated/corrupt binary, zero size, TresCanvas renderer-manager `@error`, renderer exception, `onShaderError`, epoch timeout, thrown loop, and synthetic native context loss keep or synchronously restore the static SVG and leave authentication state unchanged. Across 20 cold runs, all reach ready before the deadline; zero timeout runs are allowed. |
| Reduced motion | Reduced motion before navigation yields `omitted`: no wrapper, SVG, dynamic import, request, renderer, pointer listener, or particle-loop callback. Enabling it at runtime unmounts the canvas and passes all epoch cleanup assertions while host monitors remain live. |
| Accessibility | In every rendered state, accessibility-tree and tab-order snapshots contain no decorative node or focus target; `#login-site-title` and `.login-brand` remain present and unchanged. |
| Privacy/input | Production network logs contain only same-origin hashed chunk/binary requests with omitted credentials plus the unhashed stable public SVG; development logs allow only the configured Vite origin with CORS and omitted credentials. No pointer data is logged or sent; Pixel 7 and iPhone 13 scrolling and controls are unchanged in `omitted`. |
| Lifecycle | For unmount, hard-gate loss, failure, context loss, and late completion, assert zero callbacks after teardown, aborted fetch, removed epoch listeners/hooks, live host monitors until host unmount, and exactly one disposal each for geometry, material, and renderer. Assert canvas removal and no renderer/context work after teardown. For ready hidden/offscreen, assert the same canvas is retained and zero particle-loop callbacks occur during 2 s before clean resume. |
| Browser/device | The dated report records exact browser, engine, and OS versions for current/prior Google Chrome, Mozilla Firefox, and Apple Safari, current Firefox ESR, every release-time `browserslist` desktop target, wide Chromium at 2560×1440, and repository tablet/mobile projects. Repository engine projects do not substitute for browser-policy rows. Eligible cases meet visual/frame limits; hard-ineligible cases prove `omitted`; all cases exercise fallback and cleanup. |
| Bundles/performance | Production output passes every §12 raw, gzip, initial-delta, zero-timeout, frame-interval, particle-callback CPU, hidden/offscreen, and hard-ineligible limit and retains all existing repository budgets. |

## 15. Deliverable and acceptance traceability

### Original deliverables

| ID | Disposition | Plan coverage |
|---|---|---|
| D1 Responsive Vue/TresJS component | Retained and narrowed to a desktop decorative host plus lazy scene. | §§3, 4, 7, 9 |
| D2 TypeScript configuration and data types | Retained and narrowed to fixed constants and the versioned parser; no public options object. | §§4, 6 |
| D3 Build-time generator | Retained and made deterministic and CI-checkable. | §5 |
| D4 Three color modes | Superseded by one reviewed six-color, source-derived build-time mapping. | §§3, 5, 9 |
| D5 Custom shaders | Retained with Vite `?raw`, linear color, and fixed responsibilities. | §§4, 9 |
| D6 Mouse, pen, and touch interaction | Narrowed to primary fine mouse/pen; touch is explicitly `omitted` and scroll-safe. | §§3, 8–10 |
| D7 Reduced-motion behavior | Retained and expanded to pre-import and runtime hard-gate omission. | §§8–11 |
| D8 Static/WebGL fallback | Retained and expanded across import, Vue setup/render, fetch, parse, Tres renderer initialization, shader, deadline, loop, and context loss. | §§3, 7, 8 |
| D9 Desktop/mobile quality levels | Superseded by one desktop dataset and explicit `omitted` mobile/short/undersized behavior. | §§1, 8, 9, 12 |
| D10 Cleanup and visibility pausing | Retained with inert-canvas activity pause, hard-gate unmount, and split host/epoch ownership. | §11 |
| D11 Login integration documentation | Retained with exact Pug insertion, stacking, paths, asset origins, and authentication non-coupling. | §§2–4, 6, 7, 10 |
| D12 Browser/device report | Retained with exact versions, current/prior majors, Firefox ESR, release-time policy resolution, and named fallback/performance cases. | §§12, 14 |

### Original acceptance criteria

| ID | Disposition and evidence |
|---|---|
| A1 Recognizable at intended size | Retained: approve 16/20/24 rem captures and pre-frame SVG (§§3, 14). |
| A2 Major colors preserved | Retained and made exact: six packed colors plus source alpha; generator and screenshot checks (§§3, 5, 14). |
| A3 No monochrome/additive wash | Retained: palette-region and normal-blending captures (§§3, 9, 14). |
| A4 Smooth supported devices | Narrowed to eligible desktops; omitted mobile; exact p95/p99 and zero-timeout limits (§§9, 12, 14). |
| A5 Local displacement and return | Retained with exact falloff, 12%, 8 px, 2 px, no group parallax, and 800 ms bounds (§§3, 9, 14). |
| A6 Touch does not block use | Superseded by omitted touch wrapper/canvas/listener; scroll/control verification (§§9, 10, 14). |
| A7 Form works while loading | Retained and expanded to all auth flows under deadline delay/rejection (§§7, 8, 14). |
| A8 WebGL failure fallback | Retained and expanded to every named owned failure boundary and authentication-state assertion (§§7, 8, 14). |
| A9 Reduced-motion static | Superseded by stronger `omitted` behavior with zero wrapper/import/renderer/callback plus runtime teardown (§§8–11, 14). |
| A10 Decorative accessibility | Retained with accessibility-tree, tab-order, title, and brand assertions (§§3, 10, 14). |
| A11 GPU resources released | Retained and expanded to host/epoch listeners, async work, loop, canvas, and exactly-once geometry/material/renderer cleanup (§11, §14). |
| A12 No per-particle CPU simulation or attribute uploads | Retained: immutable attribute bytes across 600 frames; uniform-only updates (§§7, 9, 14). |
| A13 Agreed performance budget | Retained as enforceable provisional bundle/data/first-frame/frame-time/zero-work gates with recorded measurements (§§12, 14). |

## 16. Authoritative references verified 2026-09-04

- [TresJS 5.8.3 installation and Vite template compiler options](https://docs.tresjs.org/getting-started/installation)
- [TresCanvas 5.8.3](https://docs.tresjs.org/api/components/tres-canvas)
- [TresJS 5.8.3 primitives and disposal](https://docs.tresjs.org/api/advanced/primitives)
- [TresJS 5.8.3 `useLoop`](https://docs.tresjs.org/api/composables/use-loop)
- [TresJS 5.8.3 pointer events](https://docs.tresjs.org/api/events/pointer-events)
- [Vite static assets, `?url`, `?raw`, and public assets](https://vite.dev/guide/assets)
- [Vue async components](https://vuejs.org/guide/components/async)
- [Vue error capture](https://vuejs.org/api/composition-api-lifecycle.html#onerrorcaptured)
- [Three.js WebGL 2 capability check](https://threejs.org/manual/en/webgl-compatibility-check.html)
- [Three.js resource disposal](https://threejs.org/manual/en/how-to-dispose-of-objects.html)
- [MDN `webglcontextlost`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextlost_event)
- [`@tresjs/core` 5.8.3 registry metadata](https://registry.npmjs.org/@tresjs%2fcore/5.8.3)
- [`@tresjs/core` 5.8.3 declarations, including `TresCanvas` error emission](https://unpkg.com/@tresjs/core@5.8.3/dist/tres.d.ts)
- [Three.js 0.184.0 registry metadata](https://registry.npmjs.org/three/0.184.0)
- [`@types/three` 0.184.1 registry metadata](https://registry.npmjs.org/@types%2fthree/0.184.1)
- [`@resvg/resvg-js` 2.6.2 `RenderedImage.pixels` declaration](https://github.com/yisibl/resvg-js/blob/v2.6.2/index.d.ts)
- [`@resvg/resvg-js` 2.6.2 registry metadata](https://registry.npmjs.org/@resvg%2fresvg-js/2.6.2)
- [tiny-skia 0.10.0 `Pixmap` premultiplied RGBA contract](https://docs.rs/tiny-skia/0.10.0/tiny_skia/struct.Pixmap.html)
