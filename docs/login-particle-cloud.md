# Login logo particle cloud

Existing managed logo uploads automatically use the cloud renderer. The binary rendition and ordinary/static logos are unchanged; no upload, migration, or server-side reprocessing is required. Move the pointer through the cloud to stir it; click to scatter particles. The displaced particles return to their logo positions.

## Rendering and physics

The scene uses one Three.js `Points` draw call inside the existing TresJS canvas. Source positions, depth, colors, and seeds remain zero-copy, immutable views of the validated binary artifact.

The deterministic seed assigns approximately 70% of particles to fine dust, 23.5% to medium motes, and 6.5% to large beads. Source alpha controls coverage instead of giving every opaque source pixel the same diameter. The shader adds independent orbits to a coherent flow, analytic sphere lighting, and a twisting explosion that moves particles instead of fading them out. Fine dust starts at 66% opacity and skips sphere-lighting calculations; larger sprites increase coverage without adding particles or draw calls. Low-contrast colors blend toward a contrasting surface tint, without heavy outlines.

At most 512 large beads have physical spring motion and collision response. A spatial hash searches adjacent cells, visits each pair once, and caps candidate visits per bead. The simulation uses a 120 Hz fixed step with at most four steps per rendered frame; a suspended tab cannot create a catch-up backlog. Fine dust remains entirely shader animated. Bead displacements use one preallocated dynamic attribute upload (12 bytes per source particle, at most 192 KB per frame). There are no per-frame particle allocations, mesh instances, lighting passes, bloom passes, or CSS filters over the canvas.

Pointer samples feed one continuous brush, with a 65 ms follow time and a 180 ms release. Dust evaluates that brush at its current idle-plus-explosion position; the bounded physical beads use their current simulated position. The brush has a compact radius and a seed-dependent dust response. Moving the pointer over an exploded particle's original anchor cannot drag the remote particle, and brush motion never replaces the explosion's scatter/return path. The previous six overlapping GPU impulse fields could move remote particles together and snap when ring slots were recycled; the shader now evaluates one local field per particle.

Each accepted click samples a scale from 0.90–1.45 once. That scale multiplies the existing 100–240 CSS-pixel base blast radius, giving a bounded 90–348 CSS-pixel range across viewport sizes. It also scales bead impulse strength; both populations share the same radius cap and chosen scale. The six-blast capacity, 2.8-second lifetime, particle count, and physics budget are unchanged.

The renderer reads the actual surface color before its first frame and updates it when the theme changes. It stops when inactive and disposes resources on teardown. Reduced motion, unsupported WebGL, artifact failures, or context loss keep the static logo and authentication controls usable. Coarse-pointer and small viewport profiles retain the existing static/ordinary login behavior.

The default orbit illustration is omitted when a managed logo is configured. Explicit custom login backgrounds are preserved.

## Tuning

- `particle-cloud.ts`: `CLOUD_DUST_FRACTION` and `CLOUD_BEAD_FRACTION` control the population mix; both are passed as shader defines. `CLOUD_BEAD_LIMIT` caps physical beads independently of source density. Keep the fractions positive and their sum below one.
- `particle.vert.glsl`: diameter ranges at a 1024 CSS-pixel logo axis are 4–8 px, 8–12 px, and 13–20 px. Coverage and depth adjust these, with a final 22 px cap. When changing the large-bead range, update the collision radius formula in `ParticleCloud.update` too.
- `particle-cloud.ts`: spring stiffness, damping, and the fixed step control weight and settling; the hash cell must remain at least the maximum collision diameter.
- `useLogoPointer.ts`: input sampling, bounded six-slot impulse/explosion buffers, and explosion scale limits.
- `particle-brush.ts`: continuous brush follow/release and maximum deflection. The shader and physics consume this same preallocated state.

## Verification

`bun run test client/components/login-logo/particle-cloud.test.ts client/components/login-logo/LogoParticleScene.test.ts client/components/login-logo/LoginParticleLogo.test.ts client/components/login-logo/useLogoPointer.test.ts client/components/login-logo/particle-logo.test.ts client/components/login-logo/login-layout.test.ts`

Physics tests cover collision separation and exchanged velocity, scatter and return relative to an undisturbed cloud, refresh-rate independence, bounded suspension/resize handling, and a 16,000-record adversarial input. GPU transform-feedback checks run the actual vertex shader to verify current-position locality, unchanged remote blast paths, meaningful small/large scatter, and full recovery. Brush tests cover saturated ring replacement, direction reversal, release, and refresh-rate independence. The login browser suite checks rendered movement and recovery, authentication independence, failures, theme/layout behavior, reduced motion, and resource teardown.

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
