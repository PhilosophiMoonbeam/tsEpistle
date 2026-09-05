# Login logo particle cloud

Existing managed logo uploads automatically use the cloud renderer. The binary rendition and ordinary/static logos are unchanged; no upload, migration, or server-side reprocessing is required. Move the pointer through the cloud to stir it; click to scatter particles. The displaced particles return to their logo positions.

## Rendering and physics

The scene uses one Three.js `Points` draw call inside the existing TresJS canvas. Source positions, depth, colors, and seeds remain zero-copy, immutable views of the validated binary artifact.

The deterministic seed assigns approximately 70% of particles to fine dust, 23.5% to medium motes, and 6.5% to large beads. Source alpha controls coverage instead of giving every opaque source pixel the same diameter. The shader adds independent orbits to a coherent flow, analytic sphere lighting, and a twisting explosion that moves particles instead of fading them out. Low-contrast colors blend toward a contrasting surface tint, without heavy outlines.

At most 512 large beads have physical spring motion and collision response. A spatial hash searches adjacent cells, visits each pair once, and caps candidate visits per bead. The simulation uses a 120 Hz fixed step with at most four steps per rendered frame; a suspended tab cannot create a catch-up backlog. Fine dust remains entirely shader animated. Bead displacements use one preallocated dynamic attribute upload (12 bytes per source particle, at most 192 KB per frame). There are no per-frame particle allocations, mesh instances, lighting passes, bloom passes, or CSS filters over the canvas.

The renderer reads the actual surface color before its first frame and updates it when the theme changes. It stops when inactive and disposes resources on teardown. Reduced motion, unsupported WebGL, artifact failures, or context loss keep the static logo and authentication controls usable. Coarse-pointer and small viewport profiles retain the existing static/ordinary login behavior.

The default orbit illustration is omitted when a managed logo is configured. Explicit custom login backgrounds are preserved.

## Tuning

- `particle-cloud.ts`: `CLOUD_DUST_FRACTION` and `CLOUD_BEAD_FRACTION` control the population mix; both are passed as shader defines. `CLOUD_BEAD_LIMIT` caps physical beads independently of source density. Keep the fractions positive and their sum below one.
- `particle.vert.glsl`: diameter ranges at a 1024 CSS-pixel logo axis are 2.2–5 px, 5–9 px, and 11–18 px. Coverage and depth adjust these, with a final 22 px cap. When changing the large-bead range, update the collision radius formula in `ParticleCloud.update` too.
- `particle-cloud.ts`: spring stiffness, damping, and the fixed step control weight and settling; the hash cell must remain at least the maximum collision diameter.
- `useLogoPointer.ts`: input sampling and bounded six-slot impulse/explosion buffers.

## Verification

`bun run test client/components/login-logo/particle-cloud.test.ts client/components/login-logo/LogoParticleScene.test.ts client/components/login-logo/LoginParticleLogo.test.ts client/components/login-logo/useLogoPointer.test.ts client/components/login-logo/particle-logo.test.ts client/components/login-logo/login-layout.test.ts`

Physics tests cover collision separation and exchanged velocity, scatter and return relative to an undisturbed cloud, refresh-rate independence, bounded suspension/resize handling, and a 16,000-record adversarial input. The login browser suite checks rendered movement and recovery, authentication independence, failures, theme/layout behavior, reduced motion, and resource teardown.

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
