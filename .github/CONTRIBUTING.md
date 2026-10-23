# Contribute

## Introduction

First, thank you for considering contributing to Wiki.js! It's people like you that make the open source community such a great community! 😊

We welcome any type of contribution, not only code. You can help with
- **QA**: file bug reports, the more details you can give the better (e.g. screenshots with the console open)
- **Marketing**: writing blog posts, howto's, printing stickers, ...
- **Community**: presenting the project at meetups, organizing a dedicated meetup for the local community, ...
- **Code**: take a look at the [open issues](https://github.com/Requarks/wiki/issues). Even if you can't write code, commenting on them, showing that you care about a given issue matters. It helps us triage them.
- **Money**: we welcome financial contributions in full transparency on our [open collective](https://opencollective.com/wikijs).

## Your First Contribution

Working on your first Pull Request? You can learn how from this *free* course, [How to Contribute to an Open Source Project on GitHub](https://egghead.io/courses/how-to-contribute-to-an-open-source-project-on-github).

## Submitting code

Any code change should be submitted as a pull request. The description should explain what the code does, give steps to exercise it, and report the checks run. Add permanent tests when they defend a meaningful behavior, boundary, invariant, or regression; otherwise provide a focused runtime smoke result.

When auditing existing tests, trace each candidate to its supported behavior, callers, history, CI routing, and remaining coverage before removing it. Replace migration-era source spelling guards with executable coverage where they protect a real contract; retain independently grounded security, protocol, packaging, and layout requirements. For example, profile route coverage mounts the component and checks incoming-heading focus, while webhook workflow coverage checks the API payload and clean-after-save state. Use isolated negative controls to prove repaired assertions detect their intended regression, and report unreviewed candidates rather than treating classification as deletion authority.

UI layout and paint claims need a native normal-application browser flow; compiled template/style spelling and copied DOM geometry are not runtime proof. Exercise admission and authorization through current repository/runtime or HTTP consumers. For the four-attachment boundary, prove that both Attach and the actual file input disable at four ready uploads, then re-enable after deleting exactly one selected attachment. Retire an unsupported private helper and its exclusive tests together, while preserving independently live callers, server endpoints, and their behavioral coverage.

Properties-dialog regressions compile the owner's actual invocation instead of copying Vuetify props. Event transports exercise channel isolation and selected-listener removal while retaining siblings. Service-key issuance uses genuine signing credentials and token verification, so stale runtime keys, invalid grants, and expiration failures cannot hide behind a mocked token.

Marketplace checker fixtures execute the actual validator against isolated account and SSH inputs. Critical findings, including non-root account failures, must survive aggregation and exit nonzero; warning-only findings retain their zero-exit policy. SSH diagnostics identify the offending pathname without printing file contents. Ordinary fixtures omit only the root-admission gate; verify the complete script separately in disposable, network-disabled containers, never on the workstation or a maintained service.

Admin route transitions announce the incoming heading only when the entering view has not already claimed focus. Capture the active element at navigation completion and preserve newly focused content when delayed `after-enter` runs; otherwise native field selection and insertion can be split by a heading-focus jump. Retained focus in a reused view must still allow its new heading announcement. Keep first-route behavior and inert/ARIA-hidden modal boundaries intact.

Complete runtime fixtures before importing modules that capture `WIKI`, and use the real operation error constructors and authority/source-snapshot schema. Exercise durable projection admission and revision-/lease-fenced publication instead of mocking an obsolete synchronous renderer. Isolate the guard under test: an open-goal submission case must not also depend on an active-run guard. Excluded client tests can declare their Bun type context locally without widening application typecheck scope.

Generate TFA setup QR fixtures through the real `qr-image` dependency and check native dark modules against light quiet space; SVG presence alone does not prove usable contrast. A controlled login response proves QR paint, not OTP authentication or enrollment. Positive raster media fixtures must fully decode rather than merely match a PNG signature.

Presentation preference resets restore only the active locale's original `L`, `LT`, and `LTS` formats, preserving unrelated locale customizations. Regressions must exercise consecutive overrides, switching locales, and explicit timezone clearing with real Moment instances in isolated processes; do not seed the built-in locale with a prior update that masks its reset failure.

The license inventory includes the lockfile's optional dependencies for every platform, not just packages installed on the current host. When a pinned platform package is skipped by Bun, review its exact published version metadata and add an exact-version entry in `server/scripts/generate-license-inventory.ts`; do not infer a license from `license-policy.json` or the generated inventory. Regenerate with `bun run licenses:inventory` and verify with `bun run licenses:check` after a frozen install.

The Bun 1.4.3 toolchain and lock keep the direct Undici 8.x transport and Cheerio's scoped Undici 7.x copy on separately reviewed security versions. Preserve the `undici@7` scoped override and the exact Undici 8.x Bun compatibility patch when updating either line; regenerate the lockfile and license inventory, then run `bun --no-env-file server/scripts/audit-dependencies.ts` and provider-transport checks.

For security patch upgrades, preserve unrelated lock resolutions and verify every affected nested copy. A valid lockfile or clean audit alone does not prove the installed consumer's resolution: Bun can leave an obsolete nested package in an existing installation. An overridden optional peer can also retain its old locked version after `bun install`; use targeted `bun update <name>` and verify that unrelated resolutions stay unchanged. Verify the actual consumer resolver and exercised application bundle, regenerate the license inventory, and retain exact direct pins and required transitive overrides.

DOMPurify is exact-pinned at **3.4.17** for both direct sanitization and Mermaid; the SOCKS transport's `ip-address` override is **10.7.4**. Preserve those patched consumers when updating dependencies. Verify resolution from Mermaid and `@heroku/socksv5`, not only the root package, and exercise sanitization and bounded invalid IPv6-zone rejection off the maintained deployment.

Regenerate a patched dependency's patch against its exact published version; renaming an older patch is not a rebase. Bun 1.4.3 can apply stale line-offset hunks without rejecting them, corrupting a different conditional export while Node tests still pass. Verify a fresh frozen installation and the actual application browser build, preserve the patch's intended semantics, and omit package-manager marker files from generated patches.

GraphQL Tools utility security upgrades must retain compatible execution-variable shapes in every consumer. Keep the executor aligned with the patched utilities and exercise variable-valued `@include`/`@skip`, resolver arguments, and GraphQL 16's flat resolver `info.variableValues`; a clean audit does not establish executor compatibility. Preserve Git's unsafe-command guards when preparing native interrupted-operation fixtures.

Keep dedicated agent release dependency contracts aligned with an intentional SDK upgrade after exercising the engine consumers; preserve exact versions and runtime/test-only placement checks.

## Code review process

The bigger the pull request, the longer it will take to review and merge. Try to break down large pull requests in smaller chunks that are easier to review and merge.
It is also always helpful to have some context for your pull request. What was the purpose? Why does it matter to you?

For the complete isolated Bun suite, build the application assets first (`bun run build`) and provide qpdf CLI 11.9.1 or newer on `PATH` for the PDF worker tests. The TypeScript worker launches qpdf with a minimal environment, so keep the executable's runtime libraries available without relying on inherited loader settings or Python. Both quality jobs fetch the official qpdf 11.9.1 Linux x86_64 bundle, verify its SHA-256, and make it available after the static check; they also build assets before tests. Targeted tests that do not load setup assets or PDFs can run without these prerequisites.

Ordinary and native PostgreSQL media fixtures also require `ffmpeg` and `ffprobe` on `PATH` for genuine encoding, probing, and bounded complete decoding. Both hosted quality jobs install the Ubuntu `ffmpeg` package, which supplies both tools, and check both executable versions before running tests. Missing binaries are a failed prerequisite, not a reason to skip media coverage or weaken fixture validation.

Corrupt-media cases assert rejection by the application's bounded decoder, not a standalone FFmpeg invocation's exit status: FFmpeg 6.1 can report decoding errors on stderr while exiting successfully. Keep genuine positive controls and unchanged-container corruption checks; use multiple video frames when a fixture requires positive elapsed time, since FFmpeg 6.1 progress excludes the final frame's duration.

On shared hosts, do not overlap the complete ordinary suite with image builds or application typechecks. Use the existing `BUN_TEST_JOBS` worker cap when needed; it changes isolated-process concurrency, not discovery, assertions, test deadlines, or native admission. Diagnose timeout cascades before changing tests or adding retries.

`bun run ci` runs static checks, builds assets, then runs the ordinary isolated suite. For native PostgreSQL coverage, use `bun run test:postgres [exact-test-file ...]` with disposable service host, port, user and password credentials. Do not set the parent `WIKI_TEST_POSTGRES_DATABASE` or fabricate runner assignments: the allocator creates a separate database per file, rejects skips/todo through JUnit admission, and cleans up its owned databases. Ordinary-suite success is not native coverage. Foreign-key deletion checks should identify the owning constraint and accept the supported PostgreSQL restriction SQLSTATE variants (`23503` and `23001`), not localized error messages.

The routine local `native-pg18` phase and remote `native-postgres` job run the complete discovered `bun run test:postgres` suite on PostgreSQL 18; the PostgreSQL 16/17 ledger lanes retain their targeted compatibility coverage. The full native lane builds assets, requires qpdf, and includes the unchanged 250 MiB media admission proof. Its PostgreSQL fixture needs a minimum 4 GiB zero-swap cap; the former 1 GiB cap is insufficient. Use the canonical isolated runners, not a direct repository-wide `bun test --isolate` invocation that omits runner assignments.

The composite CI command first regenerates the ignored canonical build identity from the committed revision, so an earlier local build cannot make the pre-build threat-model gate reject a fresh commit. `ci:static` and standalone threat-model checks remain strict verifiers; existing metadata must still match `HEAD`. Generation rejects symlink/non-regular output and escaped output directories, and uses contained atomic replacement rather than writing through an existing hard link.

Ordinary Scarlett coverage tests create an isolated native Git history rather than depending on upstream objects retained in a developer clone. Keep the complete-coverage positive control and omitted-commit rejection together. The explicit `bun run scarlett:check` upstream audit remains responsible for fetching and checking the real reviewed history; ordinary tests must not fetch it or relax the validator when an object is absent.

Native fixtures must include the current schema and runtime dependencies of the exercised operation, even when related tables are empty. Apply the personal-MCP migration before account/group authority reloads, provide relocation and durable-job tables for storage publication, and retain canonical storage-path tables for reviewed moves. Locale activation fixtures that seed settings after migrations must persist both `sessionSecret` and `offlineDraftSecret` using `{ v: ... }` values. Mount account workspace routes on real Express for HTTP boundary checks rather than maintaining a partial router mock.

Retained-read history tests batch repetitive cached receipts in one transaction, preserving contiguous event sequences, hashes, attempts and lifecycle order. Keep the full populations that cross telemetry and metadata scan boundaries, and exercise original reads and followup/corruption transitions through the real runtime; serial fixture-write throughput must not consume the behavior test's unchanged deadline.

Prefer mounted accessible-name/state assertions over scanning every component's source for password-label grammar or caller counts. Dynamic and localized field labels are supported. Controller coverage should use real loopback HTTP when routing, JSON parsing, serialization, status or cache headers are the contract; mock the authoritative store only where database behavior is covered independently.

Administration's structural header, scroll frame, and hero must be available before the shell's first layout. Reserve authorized metric cards and the live-status line while loading; settled responses must still hide withheld totals. Diagnose native layout-shift entries instead of relaxing runtime budgets or masking loading transitions.

Client Lodash consumers use static `lodash-es` imports so unused methods can be tree-shaken. The bounded Vite aliases for shared deep helpers must stay on equivalent same-version implementations. The initial-only Lodash chunk group coalesces utilities already reachable from an entry; keep lazy editor utilities lazy and measure initial, setup, offline, and total transfer sizes rather than accepting an aggregate-only improvement. Moment is deduplicated only where installed versions and dependent ranges agree; do not force different-major peers together merely because a few emitted modules look identical. Preserve Oxc minification, source maps, all bundle budgets, and complete locale/timezone/password/diagram/editor capabilities. Validate the compiled application after changing dependency resolution.

### Fast development CI and full qualification

Normal main pushes and pull requests use `bun run ci:fast`: the complete static/typecheck/build/ordinary suite with at most four isolated test workers. The hosted workflow also runs the complete PostgreSQL 18 suite when its risk classifier requires it. Only positively allowlisted frontend/documentation changes may omit native coverage; an unknown, empty, or unavailable diff requires it. Fast success is not full qualification and never writes `last-passed.json`.

Fast CI defaults to two isolated test workers so real media encoding/decoding, Chromium startup, and logo processing do not oversubscribe the hosted runner. `BUN_TEST_JOBS` may select a lower cap or up to the existing four-worker ceiling on a capable host. This changes concurrency only: complete discovery, assertions, fixtures, and test deadlines remain enforced.

Full qualification runs nightly or on explicit request in the private `PhilosophiMoonbeam/tsEpistle-ci` controller; it is not a prerequisite for every development push or a command to run on the beta VPS. `bun run ci:local` remains the canonical complete qualification command on a capable trusted CI host. It retains static/typecheck/build/unit, PostgreSQL, migration/recovery/Helm, multiarchitecture image/logo, and every browser project. Its detached private worktree excludes ignored `.env` and login credentials, installs frozen dependencies using Bun's shared cache, reuses browser caches, and keeps results under `${XDG_STATE_HOME:-~/.local/state}/tsepistle-ci/`. `last-passed.json` is published only after every required gate and owned cleanup succeeds and identifies the exact tested revision/image.

Full local CI requires Linux x64, pinned Bun **1.4.3**, Node **24.15.0** only for the upstream pinned Playwright CLI, local Docker with preconfigured ARM64 binfmt, a running systemd user manager, cgroup v2 memory accounting, and native Playwright dependencies. Private jobs install Bun before source/origin helpers using a step-local `HOME=${{ runner.temp }}/tsepistle-bun-1.4.3`; only the job PATH changes, never the runner service PATH or shared `~/.bun`. Compatible helpers and public relays use `bun --no-env-file`. Each phase admits at most **9 GiB combined host/Docker allocation**, plus **8 GiB currently available host safety headroom**. Hard limits and zero swap remain enforced; a lower `MemoryHigh` threshold is not used because it can turn no-swap pressure into prolonged reclaim stalls.

Application image builds install OS and Bun dependencies before introducing per-revision identity. Unchanged runtime `node_modules` are copied before changing assets so that large layer remains reusable too. A source/date change still rebuilds embedded metadata, assets and final image labels without reinstalling unchanged dependencies. Base-image, Dockerfile, package, lockfile and patch changes invalidate the relevant layers. Cached OS packages do not refresh merely because upstream repositories changed; explicitly refresh those layers during OS security maintenance instead of relying on every commit date to invalidate them.

The shared-host safety policy permits **one browser lane, one Playwright worker and at most four isolated test workers**. Browser job values other than one and test job values above four are rejected before qualification begins; direct ordinary/native runners also cap their worker pool at four. Chromium, WebKit and Firefox fixture pairs run serially. Coverage, populations, sample windows and every configured project remain unchanged.

Core/accessibility/runtime-performance, including all three strict renderer profiles, runs with one worker only after every engine lane has completed and cleaned up. Browser host scopes retain 16 CPU-equivalents at `CPUWeight=10`; other scopes and BuildKit retain eight-CPU ceilings. Extra CPU bandwidth does not create additional browser instances. Both CI coordinators have separate 512 MiB hard limits, and the canonical wrapper holds the shared-state CI lock through cleanup.

The hardware-WebGL2 project runs after the other nine core projects against the same seeded application. Its matching, digest-pinned Playwright image receives only `/dev/dri/renderD128` and that device's supplemental group: non-root, read-only root filesystem, all capabilities dropped, no-new-privileges, 2 GiB RAM and zero swap. A loopback-published broker on the owned fixture network forwards client loopback without host mounts or secrets; the official image's Node runs only the upstream Playwright broker, while Bun orchestrates it. The active canvas must report unmasked representative hardware, not SwiftShader or llvmpipe. The separate host SwiftShader diagnostic retains its original workload and budgets.

| Workload | Host cap | Maximum simultaneous Docker allocation | Admission with safety headroom |
| --- | ---: | ---: | ---: |
| Frozen dependency installation | 4 GiB | None | 12 GiB available |
| Static/type/build/unit qualification | 8 GiB | None | 16 GiB available |
| AMD64, browser-worker, or ARM64 image build | 1 GiB | 8 GiB BuildKit | 17 GiB available |
| Targeted PostgreSQL compatibility/index contract | 4 GiB | 1 GiB PostgreSQL | 13 GiB available |
| Complete native PostgreSQL 18 suite | 4 GiB | 4 GiB PostgreSQL | 16 GiB available |
| Upgrade or recovery contract | 2 GiB | 5 GiB, including concurrent helpers | 15 GiB available |
| Helm contract | 2 GiB | 6 GiB kind node, including nested workloads | 16 GiB available |
| Browser qualification, one lane and one worker | 4 GiB | 2 GiB Wiki + 1 GiB PostgreSQL + 2 GiB hardware browser | 17 GiB available |

These are enforced limits and conservative admission budgets, **not measured usage or a universal minimum machine size**. A serialized phase is capped at 9 GiB across its host scope and declared Docker limits; the two 512 MiB coordinators bring the CI allocation ceiling to 10 GiB. Live sampling stops a phase if its owned running containers lack hard limits, exceed its Docker budget, or available host memory drops below 8 GiB. Before validation, the sampler also caps the exact namespace-owned kind control-plane node if it discovers it before the bootstrap poller. The largest default admission budget is 17 GiB. BuildKit retains its cache but stops between image phases. Wiki fixtures retain 2 GiB, ordinary PostgreSQL 1 GiB, native PostgreSQL 18 4 GiB and kind 6 GiB; maintained services are unchanged. Larger custom allocations must still fit the combined ceiling. Kind startup retains its documented brief pre-cap interval while the owned node is being discovered.

`resources/<phase>.json` retains the budget, host cgroup `memory.peak`/events, observed container peaks, minimum sampled host availability, and a **sampled** combined-memory peak. Cgroup memory includes charged file cache, not just RSS. Direct fixture cleanup records cgroup snapshots before removal; required snapshot failures fail qualification without preventing owned cleanup. Polling can miss other short-lived containers or their final interval, so sampled totals are not exact whole-host peaks. OOM, unsafe headroom, cancellation, missing execution receipts, and cleanup failure cannot publish a successful `last-passed.json`; maintained services are never stopped to make room.

CI scopes do **not** bound the assistant/tool process. Never load large browser traces wholesale into an assistant reader, retained Eval kernel or parallel analysis agents. Process one artifact at a time with streaming reduction in a separate scope capped at **1 GiB and zero swap**, holding the same CI lock; return only a small aggregate. Give the assistant itself a private cgroup limit rather than limiting a shared login session or user slice. A low browser count is not protection against unbounded diagnostic parsing.

The public repository has no self-hosted runner access. Its privileged full-workflow relay executes trusted **main** code with a main-only protected environment; a tag request is data, never permission to deliver the controller credential to tag-sourced code. Use a dedicated private-controller Actions read/write credential, not a broad user OAuth or publishing token. Private qualification accepts only committed trusted-main ancestry or a verified public release tag, reports unpublished local-main source explicitly, and never checks out or edits the user's working branch. Official publication remains separately authorized; ordinary development-image promotion is not a canary/full-qualification claim.

Use focused existing `bun run test`/`bun run e2e` commands for the inner loop. A normal beta image requires the fast and risk-selected checks, an immutable revision/digest, and an off-box browser smoke. The constrained VPS pulls and replaces the application only; it does not compile, install test dependencies, run browsers, or need to complete CI before an authorized hotfix push. Existing commit/push authorization rules still apply.

`dev/e2e/ci-run.sh`, `dev/e2e/upgrade-smoke.sh`, and `dev/e2e/multi-instance-smoke.sh` require a fresh `WIKI_TEST_NAMESPACE` beginning with `tsepistle-ci-` (lowercase letters, digits, hyphens). CI assigns a distinct namespace per run attempt, job, PostgreSQL version, and E2E suite where applicable; local callers should choose a new one for each invocation. These scripts refuse to reuse existing Docker resources. The application binds a Docker-assigned loopback port, and `ci-run.sh` passes the discovered URL to Playwright. Do not assume port 3000 is free or delete another run's containers, networks, or volumes during local cleanup.

`ci-run.sh` requires `POSTGRES_MAJOR`, `WIKI_TEST_NAMESPACE`, and `WIKI_E2E_SUITE=core|chromium|firefox|webkit`; invalid or missing suites fail before Docker setup. Each invocation owns one application/database pair. `dev/e2e/local-run.sh` schedules these exact selections with isolated outputs and fresh PostgreSQL 18 fixtures. Core retains ten setup/accessibility/runtime-performance projects, including WebGPU, WebGL2, and SwiftShader diagnostics; engine suites retain all four Chromium, one Firefox, and three WebKit responsive profiles, each with its Chromium setup dependency. The same bounded scheduler is used for private full qualification. Do not drop projects, alter conditional exclusions, or relax assertions, viewports, budgets, or cleanup.

Core preserves its ordinary `report.json` and records the hardware-only invocation under `e2e/core/hardware-webgl2/results.json`; either invocation failing fails the core lane. The host browser exits before the GPU broker is used, and owned cleanup removes the hardware container before Wiki or PostgreSQL.

Offline browser fixtures prefer the oldest eligible pre-seeded public pages and stop after the required cohort is found, preserving the non-home-first canonical navigation case. Do not borrow temporary pages that another parallel story owns and deletes; retain the real publication, editor, canonical URL, and source-projection admission checks.

Run `39042558719` at `6c6be26c6` demonstrated the shared-host risk: the 2026-10-17 15:16:54 UTC kernel journal recorded a global OOM killing the runner's Node process with only 104 KiB swap free. Exit 137 was not the 45-minute job timeout. The local path therefore requires headroom, bounded process/container resources, isolated namespaces, and exclusive performance execution rather than simply returning unbounded browser jobs to the shared runner. Do not compensate for resource pressure with retries or weaker checks.

AMD64 publication compares the loaded image's OCI `Descriptor.digest` with the tested registry manifest digest. Docker's local `.Id` remains the archive round-trip identity check; it is not necessarily a configuration-blob digest on containerd-backed image stores. Do not compare a manifest's `.config.digest` with that local image ID or bypass the exact tested-manifest binding.

Linux WebKit qualification uses the unmodified headless WPE runtime bundled with Playwright 1.64.0 / WebKit 27.2. Its authenticated Search and sequential-context native animation-frame, editor-selection, link, discard, and reopen flows pass without compositor-disabling flags. The older 1.62.1 / 26.5 WPE compositor crash no longer justifies a GTK override: GTK 27.2 stalls native animation frames in subsequent browser contexts despite visible, focused documents. Do not retain the obsolete headed/Xvfb workaround or mask runtime failures with skips or retries. This is Linux Playwright WebKit evidence, not branded Safari or physical iOS evidence.

Use `bun run e2e [Playwright arguments]` or `bun run e2e:responsive [Playwright arguments]` with Playwright's matching installed browser binaries and supported native dependencies. The shared launcher resolves the repository's pinned CLI; normal headless qualification does not require `DISPLAY` or Xvfb. Chromium, Firefox, and performance capability flags remain unchanged.

Run the pinned Playwright CLI with Node.js, as its shebang declares; Bun only orchestrates the launcher. `bunx` also [honors that Node shebang](https://bun.com/docs/pm/bunx#shebangs). Using Bun's `process.execPath` here silently changes Playwright's worker, timeout and teardown runtime.

The test-only `@playwright/test` pin is `1.64.0`, resolving its own `playwright-core` `1.64.0` and matching browser binaries. This includes the [WebKit offline service-worker navigation fix](https://github.com/microsoft/playwright/pull/42894); do not replace real offline emulation with an origin-outage control or a skip. Production `playwright-core` remains separately pinned at `1.62.1` for the reviewed browser worker and seccomp profile; this test-toolchain repair does not upgrade that runtime.

In Playwright 1.64.0 / Firefox 157, `setOffline(true)` blocks page fetches but service-worker fetches still reach a live origin. Retain the pre-existing Firefox offline-emulation exclusions with that precise limitation; a page-only network probe is not service-worker offline proof. Conditional exclusions are not passes or physical Firefox offline qualification.

Handled, navigation-canceled fetch diagnostics have been observed on WebKit's protocol `pageerror` channel without an uncaught Window event. The shared responsive fixture therefore observes genuine Window `error` and `unhandledrejection` events through an [early all-frame init script](https://playwright.dev/docs/api/class-page#page-add-init-script) for WebKit, retaining raw protocol reports as diagnostic attachments rather than filtering URLs or messages. Chromium and Firefox retain their protocol handling, including existing worker coverage. The WebKit guard preserves observed dedicated-worker throws but does not claim dedicated-worker rejection, shared-worker, or service-worker exception coverage.

The upload/edit/dictation and multi-turn creation-tools stories each use a 60-second whole-story orchestration budget. They retain native multipart upload/removal, image generation/private-copy editing and recording/transcription, or tool selection, two media decodes/playback checks and the next text-only turn, respectively. Individual five-second assertions and application performance/runtime budgets remain unchanged; retain the full payload, cleanup, independent-selection, playback, persistence and empty-whitelist checks.

Runtime layout-shift budgets include initial paint and permission hydration. Pages imports/registers `AdminHero` synchronously, matching Dashboard, so its full block is present at the first page paint rather than inserted by a later global async component load. Keep its actions in their own intrinsic full-width row so newly authorized controls cannot move the action group from beside the heading to below it after paint. Preserve natural button wrapping and the complete register; do not hide transitions with fixed-height clipping, delayed observation, or a relaxed CLS budget.

Particle performance qualification uses the indexed-batch/shared-motion-texture contract in [`Particle-Logo_Login.md`](../docs/.research/Particle-Logo_Login.md). Schema 4 distinguishes logical `particleCount`, declared padded `scheduledBytes`, and actual API-observed buffer/texture transfers. Preserve visual, population, frame, CPU, sample and lifecycle budgets; remove obsolete layout-pinning assertions rather than treating an old attribute byte count as a physical upload limit. Injected batching/shader diagnostics are causal evidence, not built-source qualification.

Backend-specific `logo-particle-performance*.json` files are generated check artifacts, like `runtime-performance*.json`, and are ignored rather than committed as build inputs. Preserve failure reports outside the working tree when carrying evidence across revisions; do not bypass the build metadata generator's dirty-tree guard.

The existing 1,500 ms enhancement deadline can settle the login logo to its static image before a backend exists. Opt-in startup diagnostics record only an actually fired, current, uncommitted epoch deadline; replacement epochs clear it and late callbacks cannot publish it. Generic UI checks require static opacity `1`, zero canvases and settled resources for this explicit `bounded-startup-fallback`; it is neither unsupported-capability evidence nor animated coverage. Animated outcomes retain all cursor/scatter/recovery assertions, and strict renderer profiles still require real animation within every unchanged budget.

Particle sprite raster bounds omit only the padding already rejected by the fragment's unit-disc discard. Preserve the original padded diameter in its coverage equation, physical fragment coordinates, every particle, all six explosion slots and all nonzero motion/shading equations; a smaller quad must not shrink the visible core. GPU timer-query slots must capture the current measurement epoch on reuse, preserve unavailable-extension reasons across resets, and attach full startup/performance diagnostics before assertions so workspace cleanup cannot erase failure evidence.

First-run setup autofocus must not override a field the user has already focused or redirect subsequent password typing. Preserve the native regression that drains startup timers after choosing the password field.

Confirmation sessions mount `VDialog` with its active model. Reusing an inactive overlay defers Vuetify's `globalTop` ownership and can drop an immediate Escape after reopening. Keep queued requests in the same overlay, retain leave-transition opener restoration, and preserve native keyboard qualification without added delays.

Creation-tool browser stories await the selected menu's actual dismissal before reopening through the composer's owned native ArrowDown handling. Vuetify deliberately guards immediate post-selection activator clicks. Preserve both selected-tool checks, viewport geometry, the submitted tool set, and native video/audio playback; do not replace the dismissal signal with a sleep.

Inline-Agent accessibility stories assert the Suggested prompts group's owned status, not a page-wide wording match: the same unavailable reason can also appear in the panel alert. Retain responsive geometry, accessibility scans, and native History traversal; do not resolve duplicate text by picking an arbitrary match.

Native target-size checks normalize sub-millipixel DOMRect representation error before enforcing their unchanged CSS-pixel bounds. Do not widen actual hit-target limits to accommodate floating-point coordinate noise.

Draw.io keyboard qualification covers a full forward focus loop, reverse traversal, Escape restoration, and pointer close/reopen. Do not repeat an identical forward loop: it adds native protocol time without another boundary or transition, while the reverse and reopen paths already exercise re-entry.

Iframe keyboard handoff waits until the next native frame after canceled Tab processing, then focuses both the iframe host and its [cross-origin-safe child Window](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy#window). Retain top-scope, connectivity and unchanged-focus guards; recheck authority after host focus before entering the child Window. Native Gecko traversal can stop on the parent iframe element after its child document loses focus; accept only that observed host/document boundary before one further directional key. Re-entry may retain the last child control. Never retry Tab in a loop or choose a cross-origin control through script.

JSDOM modal tests retain isolation, trusted-message boundaries, Escape and restoration, but do not assert native cross-origin iframe handoff after draining microtasks. Native browser coverage owns that transition; a DOM-only focus assertion cannot model the child browsing context or its event-processing boundary.

Below the branding picker's two-column breakpoint, stack the browser and upload panel in the existing outer scroller. The browser fills the available height but grows with wrapped controls; retain a bounded usable results area rather than a fixed whole-browser minimum. Keep complete asset-row containment inside results, real whole-row viewport reachability through native scrolling, and fully reachable Browse files/Upload controls. Desktop grid sizing remains unchanged.

Short-landscape not-found layouts place the icon beside the copy/path and keep all recovery actions below them inside the viewport. Preserve existing typography, tokens and the real Search, Home and Go back behavior rather than clipping actions beneath oversized vertical content.

Route-backed Agent browser fixtures authenticate a genuine cookie actor and leave native identity and offline-key handshakes intact. A mocked authenticated `whoami` does not authorize native page/watch/key requests. Use the existing service-worker blocking pattern only for controlled route-backed fixtures; keep real worker and offline coverage in `offline.e2e.ts`.

Controlled editor-panel fixtures that mock API reads use the shared worker-blocked `routedEditorTest`, so asset rows, declared suggestion failures, and late responses retain request ownership; [Playwright routing does not intercept service-worker requests](https://playwright.dev/docs/api/class-page#page-route). A controlling worker can otherwise return real empty asset results instead of the fixture's scrollable corpus. Real-server editor and offline contexts retain their workers. Keep the full tag suggestion/failure/removal/Cancel story separate from the short Cancel-to-Apply consumer boundary, preserving both 30-second budgets. The latter must cancel a transient tag, reopen, apply a different tag, and verify the actual Create payload excludes the canceled value. Leave the combobox with native Tab before applying.

The responsive Search API story uses the existing worker-blocked `routedReaderTest`, like the controlled reader Edit and RTL HTML payload fixtures. Its public/private result and viewport checks stay intact; native worker, identity, and offline flows keep their own worker-allowed contexts.

The stale-tag story native-clicks its below-fold combobox before text entry, bounds the first routed-query acknowledgment with the normal expectation budget, and releases the held response in `finally`. Retain the actual late-response boundary and both current/stale option assertions. Online private-history settings entry awaits its documented fragment focus, then native-clicks the secret field before typing; do not race initial route focus or substitute a model write.

Tag-follow feedback retires its animation state on the icon's genuine `animationend`, not a wall timer started before rendering. A delayed first frame must not cancel unfinished feedback. Preserve native completion, settled identity transform/no active animation, saved-follow persistence, and reduced-motion checks.

The controlled public tag-library result-ordering story alone blocks service workers so declared result responses retain ownership; real offline, follow and persistence stories keep workers. Footer qualification uses the native mobile device-profile flag plus the existing layout breakpoint: desktop profiles retain the unchanged one-pixel no-scroll requirement, while tablet/mobile content must remain reachable through real document scrolling. Exercise compact-header Browse through Page Actions, await locale listbox closure, and focus the final result before placing the document at its end. Keep footer/control bounds, no occlusion, fixed document position and horizontal containment checks.

Canonical tag-color coverage awaits the complete fixture index before taking its one-shot computed-style snapshot. The page heading can appear before the asynchronous tag response mounts its rows; heading visibility alone is not color-measurement readiness. Keep the exact fixture count, canonical identity, selected/cleared color, and icon/follow-control styling checks.

Visual-link stories first click an editable heading rather than a possibly noneditable figure, make one native unsaved edit, and await the responsive Save action's dirty label. Then use [`locator.selectText()`](https://playwright.dev/docs/api/class-locator#locator-select-text) and a private native `selectionchange` acknowledgment after ProseMirror's listener before Backspace. The real edit retires first-focus reconciliation; the acknowledgment uses the normal five-second expectation bound, never an eventless Promise that consumes the whole story. Dispose the observer on completion or failure. Modifier-only Select All is not portable here: Linux WPE's iPhone profile reports a Linux platform while Tiptap detects iOS, producing inconsistent modifier bindings. Do not override browser globals or editor models. Retain native text insertion and Shift+Home, every toolbar/exact-link assertion, discard, and saved-source reopening.

Discard/reopen qualification retains the existing authenticated browser session rather than logging in again between editor visits. This preserves the original-text, Saved, and no-unsaved-status checks while also proving session continuity; authentication remains covered by the initial genuine cookie login.

Real offline expiry coverage creates a uniquely named public page with a genuine publication end date through an isolated administrator API context, reads its actual public snapshot expiry, and cleans up the page in `finally`. Keep the real feature worker, offline emulation, save/remove actions, retained expired body, and physical snapshot/search removal checks. Advance only browser Date across expiry; leave native timers and the live server before publication ends. WebKit worker-owned requests bypass page/context routes, so an injected snapshot response is not a valid expiry fixture there.

Public saved-page opens from settings cross a document boundary after snapshot identity, expiry, policy and generation checks. Hash-only settings navigation can retain the Profile document, whose router does not own canonical page URLs. Private settings readers preserve their volatile unlock in-document. Register their history ownership guard before creating the Profile router: Chromium can invoke an earlier Window bubble listener before a later capture listener. The guard asks the mounted reader through a cancelable event; claim only canonical history entries matching an active audience-scoped private record and selection key. Retain real worker/offline navigation, Back/Forward, heading focus, the settings return hash, genuine private enrollment/save/unlock/lock coverage, and owned-fixture deletion in `finally`; do not persist or bypass the unlock handle.

DOM-only lifecycle fixtures use the existing in-document reader mode for source highlighting, authoritative body updates, focus/scroll retention, expiry and identity invalidation. Native browser coverage owns public settings' document navigation. Do not mock navigation into JSDOM or preserve the obsolete inline public Profile-reader assertion; retain the meaningful renderer and lifecycle checks in their actual reader context.

The controlled reader Edit HTML fixture alone blocks service workers so its validated payload patch owns each navigation. Real worker/offline coverage remains enabled elsewhere. Particle source-over screenshots submit the same frozen shader/pointer-clock frame after restoring canvas visibility, before sampling the visible composition; WPE may otherwise retain the preceding moving compositor surface. Preserve intrinsic state, native presentation, coordinate mapping and the unchanged pixel tolerances.

Controlled RTL boot qualification uses the same fixture-specific worker block as the reader Edit payload patch; a worker-owned navigation can otherwise bypass the intended RTL shell. Agent logout qualification retains workers and its existing story budget, but waits for the native anonymous `whoami` response and reader surface, not network idleness while background channels remain active.

Media qualification enters Wiki Agent once through its visible header action, opening the phone overflow only when needed. That authority-gated action supplies readiness without an unrelated menu-close/reopen rehearsal. Native shortcuts, Escape/focus restoration, and Search-to-Agent admission retain separate keyboard and responsive coverage. Keep all media operations in the same conversation, including independent creation-tool deselection and the next turn's explicit empty whitelist, rather than repeating unrelated entry or pre-generation selection rehearsals.

Keep emulated user agents consistent with their browser engine. Chromium tablet profiles retain their viewport, touch, mobile and device-scale settings but use a Chromium tablet user agent, not Safari's; otherwise Monaco selects a WebKit-only clipboard workaround in Chromium.

Measure initial reader rail geometry before following TOC links. After native TOC navigation, await destination focus—the existing scroll-animation completion signal—before measuring the unchanged heading bounds. A page whose entire scroll extent stays below the viewport-relative Return-to-top activation gate correctly has no such action. After opening or closing GraphQL documentation, await native Monaco relayout before applying the unchanged viewport and query-retention checks.

After a reader viewport change, await the tools card's visible responsive host before taking the one-shot history/date/Focus geometry snapshot. CSS media queries can hide its old rail before Vue Teleport moves the card; zero rectangles in that transient hidden host are not rendered-icon geometry. Retain all original icon, row, centering, matching-size and 36px fine-pointer assertions.

**Saved** confirms the source commit, not reader readiness. Save/discard/restore navigation can wait for the existing 15-second certified-render check; use the established 30-second reader-navigation assertion and still verify the committed content. Do not replay saves or bypass readiness to satisfy a five-second default assertion.

The upgrade smoke restores the archived fixture unchanged, then normalizes its public continuity asset's filename and bound cache identity from `continuity.txt` to `continuity.bin`. Both the legacy and current routers reserve `.txt` for page aliases. This fixture-only normalization preserves asset bytes, source artifact hashes, default page-extension support, and public download verification before migration, after migration, and after backup restoration.

Git synchronization may remove and recreate a child directory while a bounded filesystem observation opens or enumerates it. Own no-follow directory descriptors and traverse descriptor-relative paths. Native regressions must deliver genuine open and deferred-scan `ENOENT` after recreation: a held inode with zero links, or a different real-directory identity after a failed open, establishes removal of the original child. Root disappearance or replacement, file/symlink replacement, unchanged-directory errors, other I/O errors, and resource limits remain fail-closed; do not retry or blanket-ignore missing-path errors.

Glossary authority acquires group locks in ID order before account and membership locks, matching security-policy and membership writers. Preserve the fresh account/session check after waiting; native concurrency coverage must reject stale authority rather than retry a deadlocked write.

## Enterprise Release — security review and attestation workflow
This workflow applies only when a maintainer explicitly activates **Enterprise Release** for a named official beta, production release, or compliance milestone as defined in `AGENTS.md`. Development Sprint is the default: routine development and maintained local-tailnet deployment do not require an immutable source/attestation pair, review record, evidence document, manifest update, release tag, provenance record, or certification artifact.


tsEpistle gates Enterprise Release qualification through an explicit, manifest-driven integrity gate (`bun server/scripts/check-threat-model.ts --release`). The ordinary `bun run threat-model:check` command validates the current committed security boundary and structural threat-model contracts without claiming a current source review. Historical release models relied on a monolithic markdown table row (`Covered source`) inside the threat model; current release records are cataloged in `docs/security/review-attestations.json`.

The governing record and manifest format is `schemaVersion: 2`. Release authority is maintainer-owned: a maintainer or delegated agent performs and records the source review, and the reviewer's identity is attribution rather than a separate trust root. The former schemaVersion 1 external-review, detached-signature, and trusted-key process is superseded historical policy, not a current release prerequisite. Historical records are migrated for representation only, remain `releaseEligible: false`, and preserve their original findings and evidence.
The static prerequisite remains executable for all hosted automation: `package.json` defines `ci:static` with the exact unconditional `bun --no-env-file server/scripts/audit-dependencies.ts` segment after dependency and license checks and before broader gates, followed by `bun run threat-model:check`. Both the pull-request `pr-quality` job and the shared `quality` job invoke `bun run ci:static`; do not replace the audit with an echo, add `--ignore`/`--audit-level` variants, background it, or suppress it with `|| true`. The wrapper runs native `audit --production` from an empty manifest-only cwd because Bun 1.4.3 ignores dotenv flags for this native command; it does not suppress registry or vulnerability failures. Ordinary static validation parses the canonical threat model, validates cited non-attestation paths and scripts, and rejects staged, unstaged, untracked, ignored, index, or submodule security-boundary drift without requiring review records. Official `v`-tag quality checks invoke `--release` before publication dependencies; the beta and production jobs retain their own strict gates. A failed hosted check must be fixed rather than hidden. This automation is not the local Development Sprint acceptance command; Sprint uses the changed-path checks defined in `AGENTS.md`. The checker parses a successfully read zero-byte threat model, so an empty model cannot pass by sentinel omission.


### Canonical security boundary and digests

The canonical security boundary (policy version 1) includes:
- Source code roots: `server/`, `client/`, `shared/`, `deploy/`, `patches/`
- Developer and infrastructure tooling: the entire `dev/` prefix (including `dev/containers/`, `dev/helm/`, `dev/build/`, and all development tooling)
- CI/CD workflows and actions: `.github/workflows/`, `.github/actions/`
- Policy and configuration manifests: `package.json`, `bun.lock`, `bunfig.toml`, `biome.json`, `config.sample.yml`, `license-policy.json`, `playwright.config.ts`, `vite.config.mts`, and `tsconfig*.json`
- Root packaging, repository attribute, and legal compliance files: `.dockerignore`, `.gitattributes`, `LICENSE`, and `NOTICE`. Inclusion is essential for Docker and distribution archive integrity: `.dockerignore` establishes the container build context boundary (preventing unreviewed files or secrets from entering Docker images), `.gitattributes` governs release archive export filtering (`export-ignore`) and line endings for source distributions and release archives, and `LICENSE`/`NOTICE` establish mandatory licensing terms and attribution for container images and archives.
The gate computes a canonical `coveredTreeDigest` over every non-tree Git entry within this boundary (including files, executables, symlinks, and gitlinks/submodules) using the SHA-256 stream prefix `tsepistle-security-boundary-v1\0`, followed by entries sorted lexicographically by path formatted as `path\0mode\0type\0objectId\0`.

Documentation files (including `docs/`, `docs/security/review-attestations.json`, `docs/security/review-attestations/*.json`, and `docs/security/threat-model.md`) are intentionally excluded from the `coveredTreeDigest`. The threat model itself is validated separately by its 64-character lowercase SHA-256 content digest (`threatModelDigest`). The normative threat-model document remains model version 1; changing the record representation to schema 2 does not change the boundary or model digest algorithm.

This deliberate boundary definition is non-circular: freeze and review source commit **S**, calculate its canonical digests, then commit only the review record and manifest as documentation successor **A**. The checker requires **S** to be an existing ancestor of **A** and proves that the declared `coveredTreeDigest` equals the reviewed source boundary and the current `HEAD` boundary. It does not require a literal `source.revision === HEAD` field equality.

#### Generated build metadata exception

The security boundary checks fail closed on any uncommitted boundary changes, untracked boundary files, or ignored boundary files. The single allowed exception to ignored-boundary drift is the exact path `server/.build-metadata.json`:

- **Strict canonical requirements**: The exception is allowed only when `server/.build-metadata.json` is a non-symlink regular file, realpath-contained within the repository checkout, containing exact-object JSON with strings for `revision` and `date`, where `revision` equals the current Git `HEAD` commit SHA, and `date` is a valid canonical ISO 8601 UTC timestamp in exact JavaScript `Date.toISOString()` canonical form `YYYY-MM-DDTHH:mm:ss.sssZ` (matching the canonical output produced by `server/scripts/generate-build-metadata.ts` during `bun run build`).
- **Fail closed on malformed content or drift**: Any malformed JSON, extra or missing properties, non-regular file or symlink, mismatched revision (not matching `HEAD`), invalid date timestamp, or any other ignored file under `server/` or elsewhere within the canonical security boundary is treated as unauthorized boundary drift, fails dirty-state checks, and causes gate validation to fail closed.
- **Separate governance**: Because this file is gitignored to avoid repository pollution during local builds, it appears in `git status --ignored`. It is separately governed by build provenance and release artifact verification rather than working-tree source control.
- **Not a general server-prefix exemption**: This exception is strictly limited to the exact path `server/.build-metadata.json`. It does not create a wildcard, directory-level, or general `server/` prefix exemption. Any other ignored file under `server/` or elsewhere within the canonical security boundary is treated as unauthorized boundary drift and fails both ordinary and release gate checks.
- **Tracked content remains covered**: The path `server/.build-metadata.json` is not excluded from the security boundary definition (`isSecurityBoundaryPath`). If a file at `server/.build-metadata.json` is ever tracked in Git, it remains fully covered by the security boundary and is included in the canonical `coveredTreeDigest`.

### Step-by-step maintainer review and release procedure

To perform a security review and advance a release candidate:

1. **Freeze and commit source:**
   Ensure all changes within the security boundary are committed to Git. Note the target source commit SHA **S**. A release candidate cannot be certified from an uncommitted working tree.

2. **Calculate canonical digests:**
   Run the gate helper against **S**:
   ```console
   bun server/scripts/check-threat-model.ts --digest <source-revision>
   ```
   Record the `coveredTreeDigest` for the security boundary and the current `threatModelDigest`.

3. **Perform and document the maintainer review:**
   Review the changed and inherited security-boundary scope, reconcile evidence and residual risks, and create `docs/security/review-attestations/<id>.json` conforming to `schemaVersion: 2`:
   ```json
   {
     "schemaVersion": 2,
     "id": "<id>",
     "repository": "PhilosophiMoonbeam/tsEpistle",
     "kind": "source-review",
     "policyVersion": 1,
     "threatModelDigest": "<64-hex-sha256-of-threat-model>",
     "reviewer": {
       "identity": "Maintainer or delegated agent",
       "reviewedAt": "2026-09-08"
     },
     "releaseEligible": true,
     "source": {
       "revision": "<source-commit-S>",
       "baseRevision": "<base-commit-sha>",
       "coveredTreeDigest": "<64-hex-covered-tree-digest>"
     },
     "findings": [
       {
         "id": "SEC-001",
         "severity": "low",
         "disposition": "resolved",
         "evidencePaths": [
           "docs/security/evidence/sec-001-fix.md"
         ]
       }
     ],
     "evidencePaths": [
       "docs/security/evidence/..."
     ]
   }
   ```
   - **Repository binding:** Every review record must declare `"repository": "PhilosophiMoonbeam/tsEpistle"`.
   - **Reviewer and timestamp:** `reviewer.identity` records the responsible maintainer or agent, and `reviewedAt` is an exact UTC calendar date in `YYYY-MM-DD` format. This attribution does not assert a separate reviewer or external authority.
   - **Release eligibility:** Set `releaseEligible: true` only after the maintainer review is complete, the active source record binds the current model and exact boundary digest, all evidence paths are real and contained in the repository, and no finding has disposition `blocking`. In-repository integrity checks, clean-tree checks, ancestry, provenance, and protected release environments remain mandatory.
   - **Structured findings:** Findings must specify `resolved`, `accepted` (with written justification in cited evidence), or `blocking`. Any active record containing an open `blocking` finding is ineligible for release.
   - **Record immutability:** After the schema-2 migration, do not modify a review record in place; create a successor for a new review or status change. The one-time schema-1-to-schema-2 representation migration is historical bookkeeping, not a new approval.

4. **Select the record in the manifest:**
   Update `docs/security/review-attestations.json`:
   - Set `"schemaVersion": 2`.
   - Set `"activeReviewId"` to `"<id>"`.
   - Append `{ "id": "<id>", "path": "docs/security/review-attestations/<id>.json" }` to the `"records"` array.
   The manifest and every registered record must use schema 2; schema 1 and obsolete review properties are rejected rather than treated as a compatibility lane.

5. **Commit the attestation documentation:**
   Commit the new review record and updated manifest in `docs/security/` as documentation successor **A** after source **S**. Documentation is excluded from the security boundary, so this commit leaves `coveredTreeDigest` unchanged. If any file inside the security boundary was modified, the digest changes and the release gate fails.

6. **Execute gate validation:**
   - **Ordinary Sprint gate (`bun run threat-model:check`):** Verifies the normative threat-model structure and cited non-attestation paths, package scripts, exact unsuppressed production audit, and staged, unstaged, untracked, ignored, index, or submodule security-boundary drift (with only the canonical `server/.build-metadata.json` exception above). It does not inspect review records, bind a reviewed source revision, or confer release eligibility.
   - **Enterprise Release gate (`bun server/scripts/check-threat-model.ts --release`):** Adds schema-2 manifest and record integrity, current threat-model digest and reviewed-source/current-`HEAD` boundary equality, valid source/base ancestry and contained evidence, strict whole-checkout cleanliness, an active release-eligible source review, and zero active blocking findings. Historical release-ineligible records and their historical findings remain parseable but do not authorize or block the active release.

### Staged working-tree evidence vs. releasable source reviews

During development, specialized audits may evaluate uncommitted working-tree changes (such as the search foundation audit). These use `kind: "working-tree-audit"` and record `source: { baseRevision, fingerprint, fingerprintAlgorithm }`.
- Working-tree audits must use `releaseEligible: false`, cannot be selected as the active record, and cannot authorize deployment.
- A content fingerprint is transient evidence, not a Git commit or a substitute for a canonical `coveredTreeDigest`.
- Historical records retain their original scope, findings, and evidence after representation migration. They are explicitly superseded by the current maintainer-owned schema-2 review policy; do not reinterpret their historical limitations as current release requirements.

Releasing under an explicitly activated Enterprise Release requires committed source, a completed maintainer/agent source review, current canonical digests, real contained evidence, a clean checkout, zero active blocking findings, and the existing artifact/provenance and protected-environment checks. Development Sprint commits and local-tailnet deployments are governed instead by `AGENTS.md` and do not create this attestation package.
## Requesting new features / enhancements

Use the feature request board to submit new ideas and vote on which ideas should be integrated first.

:triangular_flag_on_post: [https://js.wiki/feedback/](https://js.wiki/feedback/)

*Do not use GitHub issues to submit new feature ideas, as it will closed and you'll be asked to use the feature request board above. GitHub Issues are limited to bugs / issues / help*.

## Financial contributions

We also welcome financial contributions in full transparency on our [open collective](https://opencollective.com/wikijs).
Anyone can file an expense. If the expense makes sense for the development of the community, it will be "merged" in the ledger of our open collective by the core contributors and the person who filed the expense will be reimbursed.

## Questions

If you have any questions, create an [issue](https://github.com/Requarks/wiki/issues/new/choose) (protip: do a quick search first to see if someone else didn't ask the same question before!).
You can also reach us at <hello@wikijs.opencollective.com>.

## Credits

### Contributors

Thank you to all the people who have already contributed to Wiki.js!
<a href="https://github.com/Requarks/wiki/graphs/contributors"><img src="https://opencollective.com/wikijs/contributors.svg?width=890" /></a>


### Backers

Thank you to all our backers! [[Become a backer](https://opencollective.com/wikijs#backer)]

<a href="https://opencollective.com/wikijs#backers" target="_blank"><img src="https://opencollective.com/wikijs/backers.svg?width=890"></a>


### Sponsors

Thank you to all our sponsors! (please ask your company to also support this open source project by [becoming a sponsor](https://opencollective.com/wikijs#sponsor))

<a href="https://opencollective.com/wikijs/sponsor/0/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/0/avatar.svg"></a>
<a href="https://opencollective.com/wikijs/sponsor/1/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/1/avatar.svg"></a>
<a href="https://opencollective.com/wikijs/sponsor/2/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/2/avatar.svg"></a>
<a href="https://opencollective.com/wikijs/sponsor/3/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/3/avatar.svg"></a>
<a href="https://opencollective.com/wikijs/sponsor/4/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/4/avatar.svg"></a>
<a href="https://opencollective.com/wikijs/sponsor/5/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/5/avatar.svg"></a>
<a href="https://opencollective.com/wikijs/sponsor/6/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/6/avatar.svg"></a>
<a href="https://opencollective.com/wikijs/sponsor/7/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/7/avatar.svg"></a>
<a href="https://opencollective.com/wikijs/sponsor/8/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/8/avatar.svg"></a>
<a href="https://opencollective.com/wikijs/sponsor/9/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/9/avatar.svg"></a>

<!-- This `CONTRIBUTING.md` is based on @nayafia's template https://github.com/nayafia/contributing-template -->
