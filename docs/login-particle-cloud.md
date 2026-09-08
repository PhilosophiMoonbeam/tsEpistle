# Login logo particle cloud

Existing managed logo uploads automatically use the cloud renderer; no upload, migration, or server-side reprocessing is required. The small login logo displays its original PNG alpha directly on the credential card, with a transparent avatar and no decorative tile. Move the pointer through the cloud to stir it; click to scatter particles. The displaced particles return to their logo positions.

## Rendering and physics

The scene uses one Three.js `Points` draw call inside the existing TresJS canvas. Source positions, depth, colors, and seeds remain immutable views of the validated binary artifact. Positions, depth, size, and seeds are uploaded directly; derived linear RGB and core alpha use a separate `Float32Array` cache, refreshed only when the background changes.

The deterministic seed assigns approximately 70% of particles to fine dust, 23.5% to medium motes, and 6.5% to large beads. Source alpha controls coverage instead of giving every opaque source pixel the same diameter. The shader adds independent orbits to a coherent flow, analytic sphere lighting, and a twisting explosion that moves particles instead of fading them out. Fine dust starts at 66% opacity and skips sphere-lighting calculations; larger sprites increase coverage without adding particles or draw calls. On light surfaces, the color cache darkens source colors toward a 3:1 core contrast target using final opacity and sRGB compositing. Its seven-step search runs at initialization and actual theme changes, rather than for every vertex on every frame. This is a tint target, not a contrast guarantee for every displayed pixel: canvas compositing, overlap, soft edges, and bead highlights also affect the result. Scaling the source channels together preserves their hue; genuinely translucent pixels retain their alpha even when that limits achievable contrast. Dark surfaces retain the luminous contrasting-tint treatment.

At most 512 large beads have physical spring motion and collision response. A spatial hash searches adjacent cells, visits each pair once, and caps candidate visits per bead. Squared-distance rejection skips square roots for particles outside a brush, blast, or contact radius; included forces and contacts retain the original arithmetic and ordering. Seed phases and damping are precomputed. The simulation uses a 120 Hz fixed step with at most four steps per rendered frame; a suspended tab cannot create a catch-up backlog. Fine dust remains entirely shader animated. Bead displacements use one preallocated dynamic attribute upload (12 bytes per source particle, at most 192 KB per frame). The color cache occupies 16 bytes per particle (256 KB at the 16,000-particle ceiling), with no per-frame color upload. There are no per-frame particle allocations, mesh instances, lighting passes, bloom passes, or CSS filters over the canvas.

Pointer samples feed one continuous brush, with a 65 ms follow time and a 180 ms release. Mouse, pen, and captured touch motion share a 31.25% strength gain and a 42 CSS-pixel travel cap (previously 32). The brush radius gains 12%, bounded at 72 CSS pixels. Dust evaluates that brush at its current idle-plus-explosion position; the bounded physical beads use their current simulated position. The brush has a compact radius and a seed-dependent dust response. Moving the pointer over an exploded particle's original anchor cannot drag the remote particle, and brush motion never replaces the explosion's scatter/return path. The previous six overlapping GPU impulse fields could move remote particles together and snap when ring slots were recycled; the shader now evaluates one local field per particle.

Each accepted click samples a scale from 0.90–1.45 once. That scale multiplies the existing 100–240 CSS-pixel base blast radius, giving a bounded 90–348 CSS-pixel range across viewport sizes. It also scales bead impulse strength; both populations share the same radius cap and chosen scale. The six-blast capacity, 2.8-second lifetime, particle count, and physics budget are unchanged.

The renderer reads the actual surface color before its first frame and updates it when the theme changes. It stops when inactive and disposes resources on teardown. Reduced motion, unsupported WebGL, artifact failures, or context loss keep the static logo and authentication controls usable. Coarse-pointer and small viewport profiles retain the existing static/ordinary login behavior.

The default orbit illustration is omitted when a managed logo is configured. Explicit custom login backgrounds are preserved.

## Renderer choice

This scene currently uses WebGL 2, not WebGPU. TresJS supports a custom renderer, and Three.js `WebGPURenderer` can select WebGPU with WebGL 2 fallback. However, this scene's GLSL `ShaderMaterial` and variable-size `Points` are not a drop-in match: WebGPU point primitives are limited to one pixel. Preserving the dust and spherical beads requires node-material shaders and instanced sprites, plus corresponding lifecycle, capture, and fallback verification. See the [Three.js WebGPU renderer guide](https://threejs.org/manual/en/webgpurenderer.html) and [PointsNodeMaterial documentation](https://threejs.org/docs/pages/PointsNodeMaterial.html).

The September 2026 audit retained the existing renderer because there was no measured backend bottleneck to justify that migration. The scene already batches all particles into one draw, caps DPR at 1.5, bounds physical beads independently of density, and stops work when inactive. Two benchmark callbacks per displayed frame count the before-render update and after-render bookkeeping; they do not represent duplicate physics steps. The motion upload remains one contiguous transfer; replacing it with hundreds of sparse updates would increase driver-call overhead. Future backend or upload-layout changes should demonstrate a benefit while preserving blend order, particle appearance, and failure behavior.

## Tuning

- `particle-cloud.ts`: `CLOUD_DUST_FRACTION` and `CLOUD_BEAD_FRACTION` control the population mix; both are passed as shader defines. `CLOUD_BEAD_LIMIT` caps physical beads independently of source density. Keep the fractions positive and their sum below one.
- `particle.vert.glsl`: diameter ranges at a 1024 CSS-pixel logo axis are 4–8 px, 8–12 px, and 13–20 px. Coverage and depth adjust these, with a final 22 px cap. When changing the large-bead range, update the collision radius formula in `ParticleCloud.update` too.
- `particle-cloud.ts`: spring stiffness, damping, and the fixed step control weight and settling; the hash cell must remain at least the maximum collision diameter.
- `particle-colors.ts`: source-to-linear conversion, theme contrast, and core opacity. Changes must agree with the GPU reference and preserve source alpha; the cache is populated before the first frame and invalidated only by background changes.
- `useLogoPointer.ts`: input sampling, bounded six-slot impulse/explosion buffers, and explosion scale limits.
- `particle-brush.ts`: continuous brush follow/release and maximum deflection. The shader and physics consume this same preallocated state.

## Verification

`bun run test client/components/login-logo/particle-colors.test.ts client/components/login-logo/particle-cloud.test.ts client/components/login-logo/LogoParticleScene.test.ts client/components/login-logo/LoginParticleLogo.test.ts client/components/login-logo/useLogoPointer.test.ts client/components/login-logo/particle-logo.test.ts client/components/login-logo/login-layout.test.ts`

Physics tests cover collision separation and exchanged velocity, scatter and return relative to an undisturbed cloud, refresh-rate independence, bounded suspension/resize handling, and a 16,000-record adversarial input. GPU transform-feedback checks run the actual vertex shader to verify current-position locality, unchanged remote blast paths, meaningful small/large scatter, and full recovery. They also check final composited contrast and preserved alpha for white, pale, and saturated particles on white, warm light, and dark surfaces. Brush tests cover strength gain, radius bounds, saturated ring replacement, direction reversal, release, and refresh-rate independence. The login browser suite checks rendered movement and recovery, transparent logo containers, authentication independence, failures, theme/layout behavior, reduced motion, and resource teardown.

With an initialized local test server:

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 bun run e2e dev/e2e/login-logo.e2e.ts --project=responsive-chromium-desktop --no-deps
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 bun run e2e dev/e2e/logo-particle-performance.e2e.ts --project=performance-desktop --no-deps
```

The performance suite exercises the 16,000-record parser ceiling, active pointer motion, repeated explosions, first-frame latency, and inactive resource use. Local measurements depend on the browser/GPU and should be repeated on target hardware.

Production-bundle check on 2026-09-05, Chromium 151.0.7922.34, 1440 × 900, DPR 1.5:

| Measurement | Result | Budget |
| --- | --- | --- |
| 20 cold starts, first frame p95 | 389 ms, zero timeouts | 1500 ms |
| 16,000 particles, 512 physical beads, repeated explosions: frame p95 / p99 | 16.9 / 17.2 ms | 20 / 34 ms |
| Animation callback CPU p95 | 0.7 ms | 2 ms |
| Hidden and offscreen callbacks | 0 | 0 |

The benchmark seeds span all particle populations and synthetic clicks use a valid mouse pointer ID. The old fixture's sequential low seeds and invalid pointer ID did not exercise the large-bead and explosion paths.

Coverage tuning check, same browser/viewport/DPR and 16,000-particle workload: after enlarging the size ranges and increasing fine-dust opacity, frame p95 / p99 measured 17.0 / 17.4 ms (previously 16.9 / 17.2 ms), callback CPU p95 remained 0.7 ms, and first-frame p95 measured 385 ms with zero timeouts. All runtime budgets still pass; particle count, draw calls, physics cap, and upload size are unchanged. Larger sprites do shade more pixels, so this is a measured absence of material slowdown on this test machine, not a claim of zero additional GPU work.

Local-brush and variable-blast check, same workload: frame p95 / p99 measured 18.5 / 20.3 ms, callback CPU p95 0.6 ms, and first-frame p95 425.2 ms with zero timeouts. Hidden/offscreen callbacks remained zero and all budgets passed. This run includes the larger random blasts; it is not a claim of identical GPU cost. The actual vertex-shader locality/scale regression passes in Chromium and WebKit. Firefox had no WebGL2 in this environment and exercised the static fallback instead.

Light-contrast and brush-strength check on 2026-09-08, production bundle and the same 16,000-particle workload: frame p95 / p99 measured 17.7 / 20.4 ms and callback CPU p95 0.6 ms. Active-animation and inactivity budgets passed. The cold-start gate did not pass: 19 of 20 starts completed (successful-start p95 395.6 ms), with one timeout in each of two runs. An independent cold-context diagnostic reproduced Chromium aborting application module downloads with `net::ERR_NETWORK_CHANGED` before Vue mounted. This host-network interruption also affected unrelated login browser cases, which passed on retry; no benchmark thresholds were relaxed. Chromium and WebKit passed the GPU contrast/locality checks and light/dark static-logo transparency checks; the mobile login/registration fallback passed.

Color-cache and physics audit on 2026-09-08:

- A warmed Bun microbenchmark used 16,000 source particles, 512 physical beads, 1,200 simulated frames, and nine alternating baseline/optimized repetitions. Median idle work decreased from 153.6 to 120.0 ms; brush-and-blast work decreased from 222.7 to 146.9 ms. All compared positions, velocities, and motion values were identical. These are CPU simulation measurements, not total frame-time or hardware-GPU claims.
- GPU transform-feedback compares cached output with a frozen copy of the previous GLSL color calculation for 1,920 color/alpha/seed/surface samples in both Chromium and WebKit. Encoded channels remain within 1/255 and alpha within 0.000001. Fixed-time 1058 × 1033 canvas captures of the configured logo differed in only two channel values in light mode and five in dark mode, each by 1/255.
- Browser instrumentation for the configured 4,673-particle logo confirmed one draw and one 56,076-byte motion upload per frame before and after. Animation callback CPU p95 changed from 0.4 to 0.3 ms; frame p95 remained approximately 17 ms. The automated browser used ANGLE/SwiftShader, offered no disjoint timer-query extension, and returned no WebGPU adapter. Hardware GPU timing and WebGPU performance therefore remain unmeasured.
- The first optimized 16,000-particle stress run measured callback CPU p95 0.4 ms and frame p95/p99 20.4/22.2 ms. It exceeded the 20 ms frame-p95 gate while unrelated host tests were consuming CPU, and two cold starts timed out. Of 18 successful starts, 17 took 373–464 ms and one took 1,069 ms; with 18 samples, nearest-rank p95 reports that maximum. These results are retained as a failed full run rather than attributed entirely to the cache or silently discarded.
- A focused ABBA comparison alternated the previous and cached shaders in the same WebGL2 context with the same 16,000-particle geometry and a synchronous pixel-readback barrier (48 measurements per variant/case). Median combined draw/readback time decreased from 9.3 to 9.0 ms for light idle, 6.6 to 6.1 ms for light interaction, 8.7 to 8.6 ms for dark idle, and 6.1 to 5.8 ms for dark interaction. Tail timings varied, but the cache showed no consistent regression. This isolates shader/attribute changes on the software renderer; it does not substitute for hardware GPU timer queries.
- The subsequent full stress run met active-animation and inactivity budgets: frame p95/p99 16.9/17.7 ms, callback CPU p95 0.5 ms, and zero hidden/offscreen callbacks. Successful cold-start p95 was 424.8 ms, with two timeouts out of 20, so the strict cold-start gate remains unresolved on this host. No thresholds or retry behavior were changed to turn it into a pass.
