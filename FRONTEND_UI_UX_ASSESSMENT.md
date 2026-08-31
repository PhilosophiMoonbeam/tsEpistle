# Frontend UI/UX assessment: evidence-based reassessment

**Disposition:** This record supersedes the former prescriptive “Luminous Archive” blueprint. It describes the current implementation and the changes completed in this workstream; it is not an implementation roadmap.

## Scope and method

The reassessment covers the Agent/Ask and Search surfaces, reader and navigation behavior, administration and authentication, accessibility ergonomics, and design-system styling. The old document’s diagnosis and recommendations were compared with the current source, focused source-contract assertions, responsive runtime observations, and the recorded typecheck, lint, build, and bundle-budget results.

Statuses in this document are deliberately narrow:

- **Confirmed and resolved** — the issue was reproduced or supported by source evidence and the workstream changed the implementation.
- **Not supported/rejected** — the old claim or recommendation was not supported by current evidence, or was superseded by a smaller fix.
- **Verification caveat** — the evidence is useful but has a stated setup, scope, or measurement limitation.

## Executive decision

The old blueprint should not be used as a handoff plan. The implementation now uses explicit responsive modes, a single ownership model for viewport and safe-area space, modal semantics only where a panel is modal, article-first reading order, and compact controls with honest names. The workstream retained targeted fixes that were supported by source or runtime evidence and rejected broad visual or structural rewrites that were not. No pending implementation checklist is carried forward in this assessment.

## Confirmed and resolved findings

| Area | Status | Original claim or observed issue | Final disposition and evidence |
| --- | --- | --- | --- |
| Agent/search | **Confirmed and resolved** | Nested `100dvh` owners and duplicated safe-area padding could compete for the Ask viewport. | Ask has one `100dvh` owner and one top/bottom safe-area owner per tier. The regular mobile Search surface intentionally reserves a **48px app-bar-extension clearance**; Ask remains full viewport. |
| Agent/search | **Confirmed and resolved** | A single, overly broad compact-panel breakpoint made desktop and tablet behavior ambiguous. | Panel modes are explicit: **wide `>=1440`**, **docked `1024–1439.98`**, and **modal `<1024`**. At `640–1023`, the modal card is explicitly in **grid column 1**. |
| Agent/search | **Confirmed and resolved** | Mobile exposed redundant Agent chrome and weak icon-only affordances. | Mobile toolbar controls are consolidated and labeled. Desktop keeps direct panel controls; mobile groups them behind a labeled panel control. The former `font-size: 0` button-content approach is not retained. |
| Agent/search | **Confirmed and resolved** | Panel scrims, dialog roles, and focus handling were applied too broadly. | Scrim, modal semantics, and focus trapping apply only in modal mode. Ask/Search/panel focus restoration follows one stack, with explicit return and close targets. |
| Agent/search | **Confirmed and resolved** | Composer textarea scrolling could chain into the transcript. | Composer overscroll is contained; compact transcript follow and composer state remain stable during viewport changes. |
| Agent/search | **Confirmed and resolved** | Small Agent citations and controls had insufficient practical hit areas or ambiguous names. | Interactive targets use the shared target sizing approach, and Agent/Search controls expose honest accessible labels such as return-to-search, close Agent, start a new conversation, and open Agent panels. |
| Reader/navigation | **Confirmed and resolved** | Mobile source order could place navigation cards before the article. | Reader layout is article-first on mobile. The TOC and supporting navigation remain available without delaying the headline and article content. |
| Reader/navigation | **Confirmed and resolved** | Mobile page actions could obstruct reading, while corner actions competed for the same thumb zone. | Mobile actions are placed in the reader’s mobile navigation/action treatment rather than a duplicate obstruction-prone speed dial; corner controls remain separated. |
| Reader/navigation | **Confirmed and resolved** | Mobile breadcrumbs and tab content were difficult to retain or reach. | Breadcrumbs remain available in a compact mobile treatment, and tab navigation scrolls horizontally with contained overscroll and mobile spacing. |
| Admin/auth | **Confirmed and resolved** | Async loading and filtering could replace useful context or make admin surfaces jump. | `AsyncState` remains localized to the surface that owns the request, including the admin locale surface; admin filters, loading states, and failures retain their local context. Admin dialog content has a bounded scrolling region so actions remain reachable. |
| Admin/auth | **Confirmed and resolved** | Admin mobile navigation and route context competed with the shell. | Mobile admin navigation uses the `mobileBrand` slot; the shell keeps the active route context legible without relying on a desktop-only route bar. |
| Admin/auth | **Confirmed and resolved** | Compact-height login forms retained empty input detail rows and wasted vertical space. | Empty input detail rows collapse at compact heights while error details remain available. Authentication controls retain usable targets, including **44px** password visibility controls. |
| Admin/auth | **Confirmed and resolved** | Mobile form/search text could trigger avoidable zoom or reduce legibility. | Authentication and search typography were adjusted with mobile target sizing and explicit search-font handling as an interaction constraint, rather than as a generic font-loading prescription. |
| Accessibility/design system | **Confirmed and resolved** | Global styling mixed hardcoded surfaces with the current token system and could lose link specificity. | Theme token and link-specificity work is applied at the targeted shared selectors. The current assessment does not claim a wholesale rewrite of every legacy theme rule. |
| Accessibility/design system | **Confirmed and resolved** | The former visual blueprint prescribed glass-heavy panels and spring polish as if they were defects. | The retained design work is tokenized and restrained: surfaces, borders, focus states, motion, labels, and target sizes support the interaction contracts without requiring a command-palette or workspace overhaul. |

## Original claims — rejected or already-fixed disposition

| Status | Original claim or recommendation | Final disposition |
| --- | --- | --- |
| **Not supported/rejected** | Replace the Agent with a command-palette/workspace glass overhaul. | No evidence required that rewrite. The smaller toolbar, panel-mode, focus, and composer fixes address the observed contracts. |
| **Not supported/rejected** | Enforce blanket `68ch` article widths and `82ch` breakout widths. | A universal measure would override real content and layout needs. Article-first ordering and mobile behavior were supported; blanket widths were not. |
| **Not supported/rejected** | Broad sticky dialog, skeleton, dashboard-height, admin-route-bar, or legacy-SCSS rewrites. | Current evidence supports localized loading, scrolling, shell, and token fixes, not global rewrites of these systems. |
| **Not supported/rejected** | Add a second reader mobile action speed dial. | Duplicate controls would recreate the obstruction and thumb-zone collision the workstream addressed. |
| **Not supported/rejected** | Preserve the stale bundle or font-loading diagnosis. | The old bundle figures and font-loading assertions were not current evidence and are replaced by the measured figures below. |
| **Not supported/rejected** | Treat every old defect-map item as an outstanding product defect. | Several were hypotheses from the blueprint, not reproduced defects. Only the supported items above are recorded as resolved findings. |

## Verification evidence

The following results are recorded from the workstream evidence; this document edit itself ran no validation command.

### Source and behavior contracts

- The focused source-contract gate recorded **33 tests across 8 files with 297 expectations** passing. Later targeted panel/header contracts also passed.
- The responsive matrix recorded **40/40 tests passed** in `dev/e2e/responsive.e2e.ts` with `--no-deps --retries=0` across the configured Chromium/WebKit device projects.
- Client/shared typecheck passed.
- Lint passed across **804 files**.
- The direct Vite production build passed.
- The bundle budget check passed.

### Measured bundle figures

The measured values are recorded exactly as reported; each value is followed by its configured budget:

| Measure | Measured / budget |
| --- | ---: |
| App initial JS (gzip) | **232.7 KiB / 480** |
| App initial CSS (gzip) | **102.7 KiB / 175** |
| Largest JS (raw) | **834.1 KiB / 1400** |
| All JS (raw) | **10202.6 KiB / 12288** |

### Verification caveat: responsive setup

**Verification caveat** — the full `bun run e2e:responsive` setup dependency was independently stale during diagnosis: its setup used outdated selectors and an outdated content-extension enable endpoint. That setup problem is not a product defect and is not recorded as one. The final responsive matrix was run against the setup-created database with `--no-deps`; its 40/40 result is the responsive evidence above. The stale setup dependency means the result must not be described as a passing end-to-end setup run.

## Remaining evidence-backed risks

1. The full responsive command remains dependent on the stale setup path described above; the validated `--no-deps` matrix is the reliable result for this workstream.
2. Bundle measurements are a snapshot of the recorded build. They establish the values above against the budgets, but do not guarantee future dependency or asset changes will remain within them.
3. Source-contract and responsive checks cover their declared contracts and configured browser/device projects; they do not establish an unrestricted visual or accessibility audit of every route.

No additional unresolved UI/UX defect is asserted without corresponding evidence.
