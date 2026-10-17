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

Complete runtime fixtures before importing modules that capture `WIKI`, and use the real operation error constructors and authority/source-snapshot schema. Exercise durable projection admission and revision-/lease-fenced publication instead of mocking an obsolete synchronous renderer. Isolate the guard under test: an open-goal submission case must not also depend on an active-run guard. Excluded client tests can declare their Bun type context locally without widening application typecheck scope.

Generate TFA setup QR fixtures through the real `qr-image` dependency and check native dark modules against light quiet space; SVG presence alone does not prove usable contrast. A controlled login response proves QR paint, not OTP authentication or enrollment. Positive raster media fixtures must fully decode rather than merely match a PNG signature.

Presentation preference resets restore only the active locale's original `L`, `LT`, and `LTS` formats, preserving unrelated locale customizations. Regressions must exercise consecutive overrides, switching locales, and explicit timezone clearing with real Moment instances in isolated processes; do not seed the built-in locale with a prior update that masks its reset failure.

The license inventory includes the lockfile's optional dependencies for every platform, not just packages installed on the current host. When a pinned platform package is skipped by Bun, review its exact published version metadata and add an exact-version entry in `server/scripts/generate-license-inventory.ts`; do not infer a license from `license-policy.json` or the generated inventory. Regenerate with `bun run licenses:inventory` and verify with `bun run licenses:check` after a frozen install.

The Bun 1.4.2 lock keeps the direct Undici 8.x transport and Cheerio's scoped Undici 7.x copy on separately reviewed security versions. Preserve the `undici@7` scoped override and the exact Undici 8.x Bun compatibility patch when updating either line; regenerate the lockfile and license inventory, then run `bun audit --production` and provider-transport checks.

For security patch upgrades, preserve unrelated lock resolutions and verify every affected nested copy. A valid lockfile or clean audit alone does not prove the installed consumer's resolution: Bun can leave an obsolete nested package in an existing installation. An overridden optional peer can also retain its old locked version after `bun install`; use targeted `bun update <name>` and verify that unrelated resolutions stay unchanged. Verify the actual consumer resolver and exercised application bundle, regenerate the license inventory, and retain exact direct pins and required transitive overrides.

GraphQL Tools utility security upgrades must retain compatible execution-variable shapes in every consumer. Keep the executor aligned with the patched utilities and exercise variable-valued `@include`/`@skip`, resolver arguments, and GraphQL 16's flat resolver `info.variableValues`; a clean audit does not establish executor compatibility. Preserve Git's unsafe-command guards when preparing native interrupted-operation fixtures.

Keep dedicated agent release dependency contracts aligned with an intentional SDK upgrade after exercising the engine consumers; preserve exact versions and runtime/test-only placement checks.

## Code review process

The bigger the pull request, the longer it will take to review and merge. Try to break down large pull requests in smaller chunks that are easier to review and merge.
It is also always helpful to have some context for your pull request. What was the purpose? Why does it matter to you?

For the complete isolated Bun suite, build the application assets first (`bun run build`) and provide qpdf CLI 11.9.1 or newer on `PATH` for the PDF worker tests. The TypeScript worker launches qpdf with a minimal environment, so keep the executable's runtime libraries available without relying on inherited loader settings or Python. Both quality jobs fetch the official qpdf 11.9.1 Linux x86_64 bundle, verify its SHA-256, and make it available after the static check; they also build assets before tests. Targeted tests that do not load setup assets or PDFs can run without these prerequisites.

On shared hosts, do not overlap the complete ordinary suite with image builds or application typechecks. Use the existing `BUN_TEST_JOBS` worker cap when needed; it changes isolated-process concurrency, not discovery, assertions, test deadlines, or native admission. Diagnose timeout cascades before changing tests or adding retries.

`bun run ci` runs static checks, builds assets, then runs the ordinary isolated suite. For native PostgreSQL coverage, use `bun run test:postgres [exact-test-file ...]` with disposable service host, port, user and password credentials. Do not set the parent `WIKI_TEST_POSTGRES_DATABASE` or fabricate runner assignments: the allocator creates a separate database per file, rejects skips/todo through JUnit admission, and cleans up its owned databases. Ordinary-suite success is not native coverage. Foreign-key deletion checks should identify the owning constraint and accept the supported PostgreSQL restriction SQLSTATE variants (`23503` and `23001`), not localized error messages.

The composite CI command first regenerates the ignored canonical build identity from the committed revision, so an earlier local build cannot make the pre-build threat-model gate reject a fresh commit. `ci:static` and standalone threat-model checks remain strict verifiers; existing metadata must still match `HEAD`. Generation rejects symlink/non-regular output and escaped output directories, and uses contained atomic replacement rather than writing through an existing hard link.

Ordinary Scarlett coverage tests create an isolated native Git history rather than depending on upstream objects retained in a developer clone. Keep the complete-coverage positive control and omitted-commit rejection together. The explicit `bun run scarlett:check` upstream audit remains responsible for fetching and checking the real reviewed history; ordinary tests must not fetch it or relax the validator when an object is absent.

Native fixtures must include the current schema and runtime dependencies of the exercised operation, even when related tables are empty. Apply the personal-MCP migration before account/group authority reloads, provide relocation and durable-job tables for storage publication, and retain canonical storage-path tables for reviewed moves. Locale activation fixtures that seed settings after migrations must persist both `sessionSecret` and `offlineDraftSecret` using `{ v: ... }` values. Mount account workspace routes on real Express for HTTP boundary checks rather than maintaining a partial router mock.

Prefer mounted accessible-name/state assertions over scanning every component's source for password-label grammar or caller counts. Dynamic and localized field labels are supported. Controller coverage should use real loopback HTTP when routing, JSON parsing, serialization, status or cache headers are the contract; mock the authoritative store only where database behavior is covered independently.

Administration's structural header, scroll frame, and hero must be available before the shell's first layout. Reserve authorized metric cards and the live-status line while loading; settled responses must still hide withheld totals. Diagnose native layout-shift entries instead of relaxing runtime budgets or masking loading transitions.

Client Lodash consumers use static `lodash-es` imports so unused methods can be tree-shaken. The bounded Vite aliases for shared deep helpers must stay on equivalent same-version implementations. The initial-only Lodash chunk group coalesces utilities already reachable from an entry; keep lazy editor utilities lazy and measure initial, setup, offline, and total transfer sizes rather than accepting an aggregate-only improvement. Moment is deduplicated only where installed versions and dependent ranges agree; do not force different-major peers together merely because a few emitted modules look identical. Preserve Oxc minification, source maps, all bundle budgets, and complete locale/timezone/password/diagram/editor capabilities. Validate the compiled application after changing dependency resolution.

### Local Docker-backed CI smokes

`dev/e2e/ci-run.sh`, `dev/e2e/upgrade-smoke.sh`, and `dev/e2e/multi-instance-smoke.sh` require a fresh `WIKI_TEST_NAMESPACE` beginning with `tsepistle-ci-` (lowercase letters, digits, hyphens). CI assigns a distinct namespace per run attempt, job, and PostgreSQL version; local callers should choose a new one for each invocation. These scripts refuse to reuse existing Docker resources. The application binds a Docker-assigned loopback port, and `ci-run.sh` passes the discovered URL to Playwright. Do not assume port 3000 is free or delete another run's containers, networks, or volumes during local cleanup.

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

First-run setup autofocus must not override a field the user has already focused or redirect subsequent password typing. Preserve the native regression that drains startup timers after choosing the password field.

Confirmation sessions mount `VDialog` with its active model. Reusing an inactive overlay defers Vuetify's `globalTop` ownership and can drop an immediate Escape after reopening. Keep queued requests in the same overlay, retain leave-transition opener restoration, and preserve native keyboard qualification without added delays.

Native target-size checks normalize sub-millipixel DOMRect representation error before enforcing their unchanged CSS-pixel bounds. Do not widen actual hit-target limits to accommodate floating-point coordinate noise.

Draw.io keyboard qualification covers a full forward focus loop, reverse traversal, Escape restoration, and pointer close/reopen. Do not repeat an identical forward loop: it adds native protocol time without another boundary or transition, while the reverse and reopen paths already exercise re-entry.

Iframe keyboard handoff waits until the next native frame after canceled Tab processing, then focuses both the iframe host and its [cross-origin-safe child Window](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy#window). Retain top-scope, connectivity and unchanged-focus guards; recheck authority after host focus before entering the child Window. Native Gecko traversal can stop on the parent iframe element after its child document loses focus; accept only that observed host/document boundary before one further directional key. Re-entry may retain the last child control. Never retry Tab in a loop or choose a cross-origin control through script.

JSDOM modal tests retain isolation, trusted-message boundaries, Escape and restoration, but do not assert native cross-origin iframe handoff after draining microtasks. Native browser coverage owns that transition; a DOM-only focus assertion cannot model the child browsing context or its event-processing boundary.

Below the branding picker's two-column breakpoint, stack the browser and upload panel in the existing outer scroller. The browser fills the available height but grows with wrapped controls; retain a bounded usable results area rather than a fixed whole-browser minimum. Keep complete asset-row containment inside results, real whole-row viewport reachability through native scrolling, and fully reachable Browse files/Upload controls. Desktop grid sizing remains unchanged.

Short-landscape not-found layouts place the icon beside the copy/path and keep all recovery actions below them inside the viewport. Preserve existing typography, tokens and the real Search, Home and Go back behavior rather than clipping actions beneath oversized vertical content.

Route-backed Agent browser fixtures authenticate a genuine cookie actor and leave native identity and offline-key handshakes intact. A mocked authenticated `whoami` does not authorize native page/watch/key requests. Use the existing service-worker blocking pattern only for controlled route-backed fixtures; keep real worker and offline coverage in `offline.e2e.ts`.

Controlled page-property tag stories use their own worker-blocked test fixture so declared suggestion failures and late responses retain request ownership; [Playwright routing does not intercept service-worker requests](https://playwright.dev/docs/api/class-page#page-route). Leave other editor and offline contexts unchanged. Keep the full suggestion/failure/removal/Cancel story separate from the short Cancel-to-Apply consumer boundary, preserving both 30-second budgets. The latter must cancel a transient tag, reopen, apply a different tag, and verify the actual Create payload excludes the canceled value. Leave the combobox with native Tab before applying.

Tag-follow feedback retires its animation state on the icon's genuine `animationend`, not a wall timer started before rendering. A delayed first frame must not cancel unfinished feedback. Preserve native completion, settled identity transform/no active animation, saved-follow persistence, and reduced-motion checks.

The controlled public tag-library result-ordering story alone blocks service workers so declared result responses retain ownership; real offline, follow and persistence stories keep workers. Footer qualification uses the native mobile device-profile flag plus the existing layout breakpoint: desktop profiles retain the unchanged one-pixel no-scroll requirement, while tablet/mobile content must remain reachable through real document scrolling. Exercise compact-header Browse through Page Actions, await locale listbox closure, and focus the final result before placing the document at its end. Keep footer/control bounds, no occlusion, fixed document position and horizontal containment checks.

Canonical tag-color coverage awaits the complete fixture index before taking its one-shot computed-style snapshot. The page heading can appear before the asynchronous tag response mounts its rows; heading visibility alone is not color-measurement readiness. Keep the exact fixture count, canonical identity, selected/cleared color, and icon/follow-control styling checks.

Visual-link stories first click an editable heading rather than a possibly noneditable figure, make one native unsaved edit, and await the responsive Save action's dirty label. Then use [`locator.selectText()`](https://playwright.dev/docs/api/class-locator#locator-select-text) and a private native `selectionchange` acknowledgment after ProseMirror's listener before Backspace. The real edit retires first-focus reconciliation; the acknowledgment uses the normal five-second expectation bound, never an eventless Promise that consumes the whole story. Dispose the observer on completion or failure. Modifier-only Select All is not portable here: Linux WPE's iPhone profile reports a Linux platform while Tiptap detects iOS, producing inconsistent modifier bindings. Do not override browser globals or editor models. Retain native text insertion and Shift+Home, every toolbar/exact-link assertion, discard, and saved-source reopening.

Real offline expiry coverage creates a uniquely named public page with a genuine publication end date through an isolated administrator API context, reads its actual public snapshot expiry, and cleans up the page in `finally`. Keep the real feature worker, offline emulation, save/remove actions, retained expired body, and physical snapshot/search removal checks. Advance only browser Date across expiry; leave native timers and the live server before publication ends. WebKit worker-owned requests bypass page/context routes, so an injected snapshot response is not a valid expiry fixture there.

Public saved-page opens from settings cross a document boundary after snapshot identity, expiry, policy and generation checks. Hash-only settings navigation can retain the Profile document, whose router does not own canonical page URLs. Private settings readers preserve their volatile unlock in-document. Register their history ownership guard before creating the Profile router: Chromium can invoke an earlier Window bubble listener before a later capture listener. The guard asks the mounted reader through a cancelable event; claim only canonical history entries matching an active audience-scoped private record and selection key. Retain real worker/offline navigation, Back/Forward, heading focus, the settings return hash, genuine private enrollment/save/unlock/lock coverage, and owned-fixture deletion in `finally`; do not persist or bypass the unlock handle.

DOM-only lifecycle fixtures use the existing in-document reader mode for source highlighting, authoritative body updates, focus/scroll retention, expiry and identity invalidation. Native browser coverage owns public settings' document navigation. Do not mock navigation into JSDOM or preserve the obsolete inline public Profile-reader assertion; retain the meaningful renderer and lifecycle checks in their actual reader context.

The controlled reader Edit HTML fixture alone blocks service workers so its validated payload patch owns each navigation. Real worker/offline coverage remains enabled elsewhere. Particle source-over screenshots submit the same frozen shader/pointer-clock frame after restoring canvas visibility, before sampling the visible composition; WPE may otherwise retain the preceding moving compositor surface. Preserve intrinsic state, native presentation, coordinate mapping and the unchanged pixel tolerances.

Controlled RTL boot qualification uses the same fixture-specific worker block as the reader Edit payload patch; a worker-owned navigation can otherwise bypass the intended RTL shell. Agent logout qualification retains workers and its existing story budget, but waits for the native anonymous `whoami` response and reader surface, not network idleness while background channels remain active.

Media qualification enters Wiki Agent through its documented native shortcut; Search-to-Agent admission has separate coverage. Keep all media operations in the same conversation, including independent creation-tool deselection and the next turn's explicit empty whitelist, rather than repeating unrelated entry or pre-generation selection rehearsals.

Keep emulated user agents consistent with their browser engine. Chromium tablet profiles retain their viewport, touch, mobile and device-scale settings but use a Chromium tablet user agent, not Safari's; otherwise Monaco selects a WebKit-only clipboard workaround in Chromium.

Measure initial reader rail geometry before following TOC links. After native TOC navigation, await destination focus—the existing scroll-animation completion signal—before measuring the unchanged heading bounds. A page whose entire scroll extent stays below the viewport-relative Return-to-top activation gate correctly has no such action. After opening or closing GraphQL documentation, await native Monaco relayout before applying the unchanged viewport and query-retention checks.

After a reader viewport change, await the tools card's visible responsive host before taking the one-shot history/date/Focus geometry snapshot. CSS media queries can hide its old rail before Vue Teleport moves the card; zero rectangles in that transient hidden host are not rendered-icon geometry. Retain all original icon, row, centering, matching-size and 36px fine-pointer assertions.

**Saved** confirms the source commit, not reader readiness. Save/discard/restore navigation can wait for the existing 15-second certified-render check; use the established 30-second reader-navigation assertion and still verify the committed content. Do not replay saves or bypass readiness to satisfy a five-second default assertion.

The upgrade smoke restores the archived fixture unchanged, then normalizes its public continuity asset's filename and bound cache identity from `continuity.txt` to `continuity.bin`. Both the legacy and current routers reserve `.txt` for page aliases. This fixture-only normalization preserves asset bytes, source artifact hashes, default page-extension support, and public download verification before migration, after migration, and after backup restoration.

Git synchronization may remove an empty child directory while a bounded filesystem observation is opening or enumerating it. Native regressions must cover deferred iterator `ENOENT`, not only `opendir` rejection; only a confirmed-absent child is tolerated. Root disappearance, replacement, symlinks, other errors, and resource limits remain fail-closed.

Glossary authority acquires group locks in ID order before account and membership locks, matching security-policy and membership writers. Preserve the fresh account/session check after waiting; native concurrency coverage must reject stale authority rather than retry a deadlocked write.

## Enterprise Release — security review and attestation workflow
This workflow applies only when a maintainer explicitly activates **Enterprise Release** for a named official beta, production release, or compliance milestone as defined in `AGENTS.md`. Development Sprint is the default: routine development and maintained local-tailnet deployment do not require an immutable source/attestation pair, review record, evidence document, manifest update, release tag, provenance record, or certification artifact.


tsEpistle gates Enterprise Release qualification through an explicit, manifest-driven integrity gate (`bun server/scripts/check-threat-model.ts --release`). The ordinary `bun run threat-model:check` command validates the current committed security boundary and structural threat-model contracts without claiming a current source review. Historical release models relied on a monolithic markdown table row (`Covered source`) inside the threat model; current release records are cataloged in `docs/security/review-attestations.json`.

The governing record and manifest format is `schemaVersion: 2`. Release authority is maintainer-owned: a maintainer or delegated agent performs and records the source review, and the reviewer's identity is attribution rather than a separate trust root. The former schemaVersion 1 external-review, detached-signature, and trusted-key process is superseded historical policy, not a current release prerequisite. Historical records are migrated for representation only, remain `releaseEligible: false`, and preserve their original findings and evidence.
The static prerequisite remains executable for all hosted automation: `package.json` defines `ci:static` with the exact unconditional `bun audit --production` segment after dependency and license checks and before broader gates, followed by `bun run threat-model:check`. Both the pull-request `pr-quality` job and the shared `quality` job invoke `bun run ci:static`; do not replace the audit with an echo, add `--ignore`/`--audit-level` variants, background it, or suppress it with `|| true`. Ordinary static validation parses the canonical threat model, validates cited non-attestation paths and scripts, and rejects staged, unstaged, untracked, ignored, index, or submodule security-boundary drift without requiring review records. Official `v`-tag quality checks invoke `--release` before publication dependencies; the beta and production jobs retain their own strict gates. A failed hosted check must be fixed rather than hidden. This automation is not the local Development Sprint acceptance command; Sprint uses the changed-path checks defined in `AGENTS.md`. The checker parses a successfully read zero-byte threat model, so an empty model cannot pass by sentinel omission.


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
