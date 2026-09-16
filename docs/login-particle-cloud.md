# Login logo particle cloud

Managed workspace logos use the ordinary image everywhere; the particle cloud is an optional login enhancement. If extraction is unsuitable or runtime enhancement fails, the ordinary logo remains usable and the icon bundle still publishes.

## Upload and rendition contract

The Workspace logo control accepts one visible static PNG, JPEG, or WebP file up to 5 MiB. Oriented dimensions must be 1–4096 pixels per axis and at most 16,777,216 pixels total. Small images and arbitrary aspect ratios are valid.

Pipeline 7 is the current contract. New uploads and migration repairs create a pipeline-7 revision and durable `process-site-logo@5` work. Pipelines 1–6 are historical compatibility data; an existing historical active revision can remain readable while its pipeline-7 replacement is processed, but new work does not publish pipeline 6.

The canonical `logo-png` is the validated, auto-oriented sRGB RGBA upload on its complete canvas. It preserves transparency, internal margins, and aspect ratio, never upscales, and downsamples only when its long axis exceeds 1024 pixels. Ordinary consumers use contained presentation rather than cropping or stretching. The active revision supplies the same ordinary logo identity to document head, navigation, authentication, registration, unlock, welcome, administration, error, mail, and preview surfaces.

Pipeline 7 also publishes square, safely padded icon renditions: `favicon16`, `favicon32`, the two-size ICO, `app192`, and `app512` are transparent; `tile150`, `apple180`, and `maskable512` are opaque with their role-specific backdrop. The ICO contains the transparent 16 px and 32 px favicon images. Icons are not uniformly opaque, and the application manifest uses the `app192`/`app512` any-purpose icons plus the `maskable512` maskable icon.

Particle and static-effect artifacts are generated only when the source is suitable for the effect. Their absence never blocks the ordinary logo or icon bundle. A ready enhancement carries the validated particle binary and transparent static effect; an unavailable enhancement falls back to the ordinary logo.

## Rendering and physics

The physical canvas is full-bleed across the available right-hand login field, from the field edges to the available viewport edges. The former contained layout is retained as a logical content rectangle: the source aspect ratio is fitted and centered with the old 8% clearance inside that field. The ordinary image, static effect, particle coordinates, displayed stroke, and interaction geometry use that logical rectangle; the canvas itself is not the contained rectangle.

The scene uses Three.js `WebGPURenderer` with a TSL `SpriteNodeMaterial` over one indexed instanced quad mesh. Each source-order particle is one sprite instance, one draw renders all `N` sprites as `2N` indexed triangles, and the only scheduled per-frame transfer is the source-order vec2 motion attribute (`8*N` bytes, at most 128 KB at the 16,000-record parser ceiling). Source positions, depth, colors, alpha, and seeds remain immutable renderer inputs derived from the validated binary artifact. Straight source sRGB bytes are decoded once to a separate Linear-sRGB cache; RGB remains independent of source alpha, seed, theme, and backdrop.

The deterministic seed assigns approximately 70% fine dust, 23.5% medium motes, and 6.5% large beads. Source alpha controls coverage. The TSL graph combines coherent flow, independent orbits, analytic bead lighting, and a moving explosion; it does not recolor particles from the backdrop or fade the explosion as a substitute for motion. At most 512 large beads receive fixed-step spring and collision response; fine dust remains entirely TSL animated. The simulation uses a 120 Hz fixed step with at most four steps per rendered frame and cannot create a suspended-tab catch-up backlog.

The static effect is transparent and is also the CSS alpha mask for the soft silhouette behind the ordinary image: light theme uses black at 12% alpha, and dark theme uses white at 8% alpha. The mask changes silhouette coverage only; ordinary source colors and alpha remain source-faithful. Theme changes update surrounding UI and backdrop, not the cached particle colors.

Pointer input uses one continuous brush with a 65 ms follow and 180 ms release, a 42 CSS-pixel travel cap, and a radius bounded at 72 CSS pixels. Accepted clicks use one scale in `0.90–1.45`, multiplying the `100–240` CSS-pixel base blast radius (a bounded `90–348` CSS-pixel range) and bead impulse strength. Six impulse slots and six explosion slots are retained. The analytic explosion envelope is zero at age 0, reaches its hold peak at 0.35 s, returns exactly to baseline at 2.75 s, and the slot expires at 2.8 s; it never requires a fade-out to restore the baseline.

During temporary hidden or offscreen visibility pauses, the committed canvas, backend lease, scene resources, and lifecycle remain mounted while application update/render callbacks, pointer work, draws, and motion transfers stop; the committed static coverage remains until a resumed frame. Terminal failure or device/context loss, descriptor replacement, reduced motion, and unmount retire and dispose the renderer lease and scene resources, remove the canvas, and leave authentication on its ordinary/static fallback.

## Renderer and backend policy

The shared scene path is `WebGPURenderer` plus TSL `SpriteNodeMaterial`, an indexed instanced quad, and source-order attributes. Native WebGPU is primary. A deliberate `webgl2` request uses `forceWebGL` and requires strict WebGL2; `auto` accepts native WebGPU or only a successful built-in WebGL2 fallback from `WebGPURenderer`. The requested backend, effective backend, generation, phase, fallback flag, and diagnostic reason are committed before the first visible particle frame.

The material emits already-encoded sRGB with straight RGB/alpha, `premultipliedAlpha:false`, and `NormalBlending`; the renderer uses `LinearSRGBColorSpace` and `NoToneMapping`, and the premultiplied canvas supplies native source-over composition. No color buffer is recalculated or uploaded on theme changes. Three's common renderer may retain lightweight page-global bookkeeping while visibility is paused, but it must not produce particle updates or draws.

The `performance-webgpu`, `performance-webgl2`, and `performance-webgl2-swiftshader` Playwright projects are the profiling entry points. Every report must identify `requestedBackend` and `effectiveBackend`, retain backend diagnostics for each eligible context/generation, and record graphics identity plus its `representative-hardware`, `software-diagnostic`, or `unavailable` classification. Keep the scheduling `renderCallbackGap` separate from direct synchronous `renderInvocationCpuMs` (and the other phase-CPU samples). GPU timer-query samples are a separate field; an unavailable query is unavailable, never zero.

Current local headless evidence is diagnostic, not a runtime-budget pass. At 1440×900 and DPR 1.5, the strict WebGPU profile observed active frame p95/p99 of 17.2/19.8 ms and callback CPU p95 of 0.6 ms, but failed complete profiling: 5 of 20 cold starts exceeded the 2 s gate, Chromium reported SharedImage backing failures, and a follow-up run exhausted the 180 s harness timeout during context churn. The strict forced-WebGL2 profile completed backend identity and 20 of 20 cold starts (p95 696.9 ms) with callback CPU p95 1.0 ms, but missed the active frame target at p95/p99 148.6/186.8 ms with only 87 interval samples. These headless profiles classify graphics as `software-diagnostic`; they do not establish representative hardware throughput or a passed runtime budget. The SwiftShader project is likewise a software diagnostic.

Historical WebGL renderer measurements (retained for comparison; not results for the current WebGPU/TSL scene):

| Measurement | Result | Budget |
| --- | --- | --- |
| 20 cold starts, first frame p95 | 389 ms, zero timeouts | 1500 ms |
| 16,000 particles, 512 physical beads, repeated explosions: frame p95 / p99 | 16.9 / 17.2 ms | 20 / 34 ms |
| Animation callback CPU p95 | 0.7 ms | 2 ms |
| Hidden and offscreen callbacks | 0 | 0 |

The historical audit retained a single contiguous motion transfer and bounded physical beads independently of density. Its WebGL measurements remain dated evidence only; they do not validate the current WebGPU/WebGL2 backend path or imply that native profiling has passed. Historical color-cache and physics measurements, shader comparisons, and software-renderer readback timings are retained only as implementation history, not as hardware-GPU evidence.

## Tuning

- `particle-cloud.ts`: `CLOUD_DUST_FRACTION` and `CLOUD_BEAD_FRACTION` control the population mix used by the TSL graph. `CLOUD_BEAD_LIMIT` caps physical beads independently of source density.
- `particle-material.ts`: TSL sprite diameter ranges at a 1024 CSS-pixel logical axis are 4–8 px, 8–12 px, and 13–20 px, with a final 22 px cap. Update the collision-radius formula in `ParticleCloud.update` when changing the large-bead range.
- `particle-cloud.ts`: spring stiffness, damping, and the fixed step control settling; the hash cell must remain at least the maximum collision diameter.
- `particle-colors.ts`: decode source sRGB to Linear-sRGB once and keep RGB/alpha independent. The material emits direct sRGB once; `LinearSRGBColorSpace`, `NoToneMapping`, `premultipliedAlpha:false` material state, and the `premultipliedAlpha:true` canvas are intentional composition controls, not a claim that fragment values are linear.
- `particle-explosion.ts`: keep the six-slot envelope, `0.35 s` hold, exact `2.75 s` baseline return, and `2.8 s` lifetime aligned between CPU diagnostics and the TSL graph.
- `useLogoPointer.ts` and `particle-brush.ts`: maintain bounded pointer sampling, six-slot impulse/explosion state, brush follow/release, and maximum deflection.

## Verification

Focused unit coverage:

```sh
bun run test client/components/login-logo/particle-colors.test.ts client/components/login-logo/particle-cloud.test.ts client/components/login-logo/particle-explosion.test.ts client/components/login-logo/LogoParticleScene.test.ts client/components/login-logo/LoginParticleLogo.test.ts client/components/login-logo/useLogoPointer.test.ts client/components/login-logo/particle-logo.test.ts client/components/login-logo/login-layout.test.ts
```

With an initialized local test server, the browser checks are:

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 bun run e2e dev/e2e/login-logo.e2e.ts --project=responsive-chromium-desktop --no-deps
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 bun run e2e dev/e2e/logo-particle-performance.e2e.ts --project=performance-webgpu --no-deps
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 bun run e2e dev/e2e/logo-particle-performance.e2e.ts --project=performance-webgl2 --no-deps
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 bun run e2e dev/e2e/logo-particle-performance.e2e.ts --project=performance-webgl2-swiftshader --no-deps
```

The performance hook is caller-owned and must be installed before app load. Reports should include first-frame samples, active frame intervals, phase CPU, callback gap, direct-render CPU, separate GPU timing, backend diagnostics/identity, draws from renderer-info deltas, logical scheduled motion bytes, and actual upload calls/bytes only when publicly observed. Missing upload or GPU-query observations remain unavailable. Visibility checks require zero application callbacks, draws, scheduled motion bytes, and observed uploads while the retained lifecycle remains mounted; resume must record a committed frame. Local measurements must retain their browser/GPU identity and failed status.
