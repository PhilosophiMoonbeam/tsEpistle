# tsEpistle ("Tim O'Pedia") — 2nd Comprehensive Frontend Design Assessment & Implementation Handoff

**Target Application:** `tsEpistle` ("Tim O'Pedia" — Enterprise Wiki, Knowledge Graph, Agent + Memory Workspace)
**Inspection Scope:** Live authenticated instance across Light Mode (`1440×900`), Dark Mode (`1440×900`), Tablet (`768×1024`), and Mobile (`390×844`) — 94 rendered surface captures, accessibility DOM trees, and computed CSS/token audits.
**Document Role:** Actionable architectural and UI/UX engineering handoff for implementation agents.

---

## 1. Executive Design Thesis — *Luminous Archive 2.0: Timeless Materials, Quiet Authority, Zero-Friction Recall*

`tsEpistle` already possesses the embryonic DNA of a distinctive product: warm mineral paper tones (`#F9F6EE` / `#FFFDF9`), obsidian ink (`#171512`), Newsreader editorial display typography paired with Plus Jakarta Sans and JetBrains Mono, and an ambitious unification of structured wiki authoring with source-grounded AI memory.

Yet compared to flagship 2026/2027 professional knowledge and agent workspaces, the live interface currently reads as **visually noisy, spatially uncalibrated, and mechanically self-interrupting**. Five systemic anti-patterns account for 85% of that friction:

1. **Wireframe Border Overload & Accidental Flatness:** Although [`client/scss/base/base.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/base/base.scss#L53-L243) defines a rich mineral surface gradient (`--wiki-surface-gradient`) and directional specular border (`--wiki-specular-border`), [`client/scss/app.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/app.scss#L67-L88) restricts them to `:where(.v-card.v-card--variant-elevated)` while [`client/helpers/app-vuetify.ts`](file:///home/bbferko/repos/tsEpistle/client/helpers/app-vuetify.ts#L37) sets the global `VCard` default to `variant: 'flat'`. Consequently, 90% of cards across Reader, Profile, Editor, and Administration bypass the material system entirely and fall back to flat fills wrapped in hard `1px` borders (`--wiki-surface-border`).
2. **Translucent Collision Instead of Layered Glass:** Where glass transparency is attempted (such as the Agent composer dock when scrolling a conversation or the Reader Focus Mode bottom HUD), underlying prose bleeds directly through interactive buttons and input fields without a scroll-mask apron or sufficient surface opacity, creating illegible double-exposure collisions.
3. **Redundant Chrome & Repeated Context:** The Wiki Agent workspace renders [`agent-context-summary.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-context-summary.vue) twice simultaneously (once in the header, once inside the composer) and repeats the current page title four times before the user types a character. The Reader stacks two adjacent left sidebars (`260px` workspace nav + `220px` `ON THIS PAGE` TOC = `480px` of left rail). Administration pages stack two giant display-serif hero banners ("Pages" followed by *"A clear view of every page."*) that push actual data tables to the bottom 20% of desktop viewports and 100% off-screen on mobile.
4. **Broken Form-Field & Motion Mechanics:** Every outlined Vuetify input across the entire application paints a `3px` rectangular focus `box-shadow` directly through the open floating-label notch ([`client/scss/components/v-form.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/components/v-form.scss#L91)). Meanwhile, the Reader TOC runs an unconditional `4s` infinite horizontal marquee oscillation ([`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue#L5888-L5912)) that slices active section headings on both left and right edges while ignoring `prefers-reduced-motion`.
5. **Inverted Visual Weight & Action Hierarchy:** High-saturation solid orange (`#F9A134`) is spent on secondary actions (`Change Password` on an untouched Profile form) or normal online telemetry (`Reports a connection` in Offline Library), while primary workflow commitments (`Save and close` in the Editor, `Save changes` in Profile) blend into rows of identical flat gray pills.

---

## 2. Target Material, Gradient & Glass Architecture ("Timeless Materials")

To elevate `tsEpistle` into an unmistakable 2026/2027 enterprise product, replace ad-hoc borders and unmasked translucency with a strict **4-Tier Material Matrix** defined in [`client/scss/base/base.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/base/base.scss#L53-L243) and [`client/scss/app.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/app.scss#L26-L112):

| Tier | Material Archetype | Light Mode Tokens | Dark Mode Tokens | Assigned Surfaces |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 0** | **Archival Linen Canvas** (Ambient Base) | `--wiki-canvas-bg: #F9F6EE` with subtle top-left warm gold (`3.5%`) and bottom-right mineral teal (`2.2%`) radial washes | `--wiki-canvas-bg: #12100E` with low-contrast `2%` warm amber and `1.5%` teal radial washes (eliminating hard hero-to-body banding) | Root document background, Reader outer canvas, Admin/Profile main scroll bed |
| **Tier 1** | **Mineral Vellum** (Primary Structural Cards & Panels) | `background: linear-gradient(155deg, color-mix(in oklch, #FFFDF9 96%, #F9A134 4%) 0%, color-mix(in oklch, #F9F6EE 97%, #2D6A6E 3%) 100%)`; `border: 1px solid color-mix(in oklch, var(--wiki-surface-border) 78%, var(--wiki-accent-warm) 22%)`; `box-shadow: var(--wiki-specular-border), var(--wiki-shadow-xs)` | `background: linear-gradient(155deg, color-mix(in oklch, #221E1A 95%, #F9A134 5%) 0%, color-mix(in oklch, #1A1714 96%, #2D6A6E 4%) 100%)`; `border: 1px solid rgba(244, 239, 230, 0.09)`; `box-shadow: inset 0 1px 0 rgba(255, 248, 235, 0.06), var(--wiki-shadow-xs)` | Reader hero card, Profile section cards (`.profile-section`), Admin operational cards, Agent response cards, Tag discovery cards |
| **Tier 2** | **Carved Slate / Sunken Well** (Recessed Data & Code Surfaces) | `background: var(--wiki-surface-sunken)` (`#F1ECE1`); `box-shadow: var(--wiki-shadow-inset)`; `border: 1px solid rgba(23, 21, 18, 0.07)` (zero top specular highlight) | `background: var(--wiki-surface-sunken)` (`#0D0B09`); `box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.55)`; `border: 1px solid rgba(244, 239, 230, 0.06)` | Code blocks (`pre`), data table headers/wells, resting form inputs, empty-state wells, diff viewers, JSON preview boxes |
| **Tier 3** | **Smoked Quartz Glass** (Persistent Chrome, Floating Docks & Overlays) | `background: linear-gradient(180deg, rgba(255, 253, 249, 0.88) 0%, rgba(249, 246, 238, 0.82) 100%)`; `backdrop-filter: blur(20px) saturate(145%)`; `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65), var(--wiki-shadow-md)` | `background: linear-gradient(180deg, rgba(34, 30, 26, 0.86) 0%, rgba(22, 19, 16, 0.82) 100%)`; `backdrop-filter: blur(22px) saturate(150%)`; `box-shadow: inset 0 1px 0 rgba(255, 248, 235, 0.10), var(--wiki-shadow-md)` | Top `nav-header`, Search/Agent Command modal shell, Agent composer dock (paired with an opaque scroll-mask apron), Reader Focus dock, Tiptap `/` slash menu, context popovers |

### Non-Negotiable Glass Hygiene Rule
Whenever a **Tier 3 Smoked Quartz Glass** dock sits over a scrolling viewport (e.g., the Agent composer in [`inline-agent-chat.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/inline-agent-chat.vue) or the Focus Mode dock in [`page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue)), the scroll container **must** reserve bottom padding equal to the dock height plus `24px`, and a `32px` vertical gradient fade mask (`linear-gradient(to top, var(--wiki-canvas-bg) 35%, transparent)`) **must** sit beneath the glass dock so scrolling text softly dissolves before reaching interactive controls.

---

## 3. Purposeful Time-Utility & Micro-Joy Prescriptions (Without Distraction)

1. **Instant Recall on `Ctrl+K` (Zero-Keystroke Utility):** Opening the Search overlay currently presents a dead empty card with a button (`Browse current view`) that closes the modal just opened. Replace this with an immediate **Recent & Pinned Working Set** list (last 5 visited/edited pages + 1-click keyboard jump pills for `✨ Ask Agent about current page`, `➕ New page in current folder`, and `🏷️ Browse tags`).
2. **Tactile Citation & Source Provenance:** In the Agent thread, inline citation badges (`[1]`, `[2]`) should sit inline at the end of claims like typeset footnote numerals (`font-family: var(--wiki-font-mono); font-size: 0.72rem; vertical-align: super`) with a warm mineral glass pill that, on hover or focus, reveals a compact 2-line excerpt preview card before the user even opens the right-hand Source Notebook.
3. **Calm, Truthful Reading Progress:** Replace the broken `0% read` suffix repeated 47 times in the TOC accessibility tree and the oscillating text marquee with a single `2px` hairline warm-gold progress filament along the top border of the sticky TOC card (or Focus dock) that updates smoothly from `0%` to `100%` as the article scrolls.
4. **Diff-First Save Confidence:** When editing a page or admin setting, keep the primary save CTA quiet (`tonal`) when clean, and transition it smoothly (`180ms cubic-bezier(0.22, 1, 0.36, 1)`) to the warm mineral-amber gradient pill (`var(--wiki-accent-warm)`) the moment the buffer or form becomes dirty.

---

## 4. Exhaustive Surface-by-Surface Findings & Prescriptions

### Priority & Severity Key
- **P0 (Critical):** Breaks legibility, occludes interactive controls/content, corrupts spatial navigation, or violates HTML/a11y semantics across core workflows.
- **P1 (High):** Major visual hierarchy, layout balance, density, or workflow friction defect that makes the product feel unfinished or fatiguing.
- **P2 (Medium):** Polish, alignment, copy, or localized component inconsistency.

---

### A. Systemic Cross-Cutting Foundations (`SYS`)

#### `SYS-01` (P0) — Outlined Input Focus Halo & Floating-Label Notch Collision Across All Forms

- **Components:**
  - [`client/scss/components/v-form.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/components/v-form.scss#L21-L104)
  - [`client/components/editor.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor.vue#L3167-L3187)
  - [`client/components/admin.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin.vue#L454-L465)
- **Observed Problems:**
  - Inspected across `/login` (Light & Dark), `Choose section` in Reader Focus Mode, `Select New Page Location`, `Page Properties`, `/p/profile`, `/a/general`, `/a/theme`, and `/a/search`.
  - In [`client/scss/components/v-form.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/components/v-form.scss#L91), `:where(.v-field--focused, .v-field:focus-within)` applies `box-shadow: 0 0 0 3px color-mix(in oklch, var(--wiki-focus-color) 18%, transparent)` directly to `.v-field`. Because `.v-field` is an un-notched rectangle while `.v-field__outline` uses a notched gap (`.v-field__outline__notch`) for the floating `.v-field-label`, the `3px` outer focus shadow paints a continuous horizontal bar right through the floating label gap behind the text (`Email Address`, `Title`, `Site Title`).
  - Simultaneously, [`v-form.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/components/v-form.scss#L26-L31) sets `--wiki-control-edge: color-mix(in oklch, rgb(var(--v-theme-on-surface)) 44%, transparent)` and forces `--v-field-border-opacity: 1` on `.v-field__outline`. This heavy 44% resting outline stops within `~3px` of the floating label's first and last glyphs, visually pinching every floating label on unfocused fields.
- **User Impact:**
  - Every form in `tsEpistle` looks visually glitched whenever a field is focused or populated; floating labels appear struck through by a glowing band or squeezed by dark border ends.
- **Specific Corrections:**
  1. In [`client/scss/components/v-form.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/components/v-form.scss#L26-L49), reduce resting `--wiki-control-edge` from `44%` to `24%` (`28%` in Dark Mode), rising to `42%` on `:hover:not(.v-field--focused)`.
  2. Give `.v-field--variant-outlined .v-field__outline__notch` explicit horizontal breathing room and mask backing for the floating label:
     ```scss
     :where(.v-field--variant-outlined .v-field__outline__notch) {
       padding-inline: 6px;
     }

     :where(.v-field--variant-outlined .v-field-label--floating) {
       padding-inline: 5px;
       margin-inline: -1px;
       border-radius: 4px;
       background-color: var(--wiki-field-label-bg, rgb(var(--v-theme-surface)));
       z-index: 2;
     }
     ```
  3. Replace the un-notched `0 0 0 3px` box-shadow on `.v-field--variant-outlined:focus-within` with a notch-respecting outline glow (`filter: drop-shadow(0 0 3px color-mix(in oklch, var(--wiki-focus-color) 32%, transparent))` on `.v-field__outline` or `box-shadow: 0 2px 8px -2px color-mix(in oklch, var(--wiki-focus-color) 28%, transparent)` on `.v-field`) so no horizontal bar crosses the top notch.
  4. Remove duplicate ad-hoc `.v-field__outline` overrides in [`client/components/editor.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor.vue#L3167-L3187) and [`client/components/admin.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin.vue#L454-L465) so all surfaces inherit the single corrected field system.
- **Final Acceptance Criteria:**
  - Focusing any outlined `v-text-field`, `v-select`, `v-autocomplete`, or `v-textarea` in Light or Dark Mode shows zero horizontal shadow/border line passing behind or through the floating label text, with at least `6px` clear space between the label glyphs and the left/right outline notch segments.

---

#### `SYS-02` (P1) — Disconnected Material Tokens (`VCard` Flat Default Bypassing `--wiki-surface-gradient` & `--wiki-specular-border`)

- **Components:**
  - [`client/helpers/app-vuetify.ts`](file:///home/bbferko/repos/tsEpistle/client/helpers/app-vuetify.ts#L35-L45)
  - [`client/scss/app.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/app.scss#L67-L88)
  - [`client/scss/base/base.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/base/base.scss#L53-L243)
  - [`client/helpers/theme.ts`](file:///home/bbferko/repos/tsEpistle/client/helpers/theme.ts#L196-L218)
- **Observed Problems:**
  - [`client/helpers/app-vuetify.ts`](file:///home/bbferko/repos/tsEpistle/client/helpers/app-vuetify.ts#L37) sets `VCard: { variant: 'flat', rounded: 'lg' }`. Meanwhile, [`client/scss/app.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/app.scss#L67-L88) scopes `--wiki-surface-gradient` and `--wiki-specular-border` exclusively to `:where(.v-card.v-card--variant-elevated)`.
  - As a result, almost no cards in the application receive the mineral gradient or top-edge specular highlight. Instead, they render as flat beige (`#FFFDF9`) or flat charcoal (`#1C1916`) boxes outlined with `1px` gray borders.
  - Conversely, in Dark Mode (`1440×900`, `/en/home` and `/a/theme`), the ambient radial gradient on `html, body, .v-application` ([`client/scss/app.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/app.scss#L26-L31)) combines with the Reader hero background to produce a noticeable horizontal brightness step between the hero strip and the article canvas.
- **User Impact:**
  - The UI feels like a collection of flat wireframes rather than a cohesive, tactile workspace crafted from timeless archival materials.
- **Specific Corrections:**
  1. In [`client/scss/app.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/app.scss#L67-L88), apply Tier 1 **Mineral Vellum** (`background-image: var(--wiki-surface-gradient)`, `box-shadow: var(--wiki-specular-border), var(--wiki-shadow-xs)`, and warm-tinted hairline border `color-mix(in oklch, var(--wiki-surface-border) 78%, var(--wiki-accent-warm) 22%)`) to primary structural cards: `:where(.v-card.v-card--variant-elevated, .v-card.v-card--variant-flat:not(.wiki-well, .v-card--sunken))`, `.profile-section`, `.admin-agent-control`, `.stat-card`, `.discovery-card`, and `.page-toc-card`.
  2. Create an explicit `.wiki-surface-well` / Tier 2 token recipe using `--wiki-surface-sunken` and `--wiki-shadow-inset` (with `background-image: none`) for nested cards, code containers, empty states, and data-table wells so nested cards never stack gradient-on-gradient.
  3. In [`client/scss/base/base.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/base/base.scss#L148-L243), tune Dark Mode `--wiki-surface-gradient` and body radial washes so the luminance delta between Tier 0 (`#12100E`) and Tier 1 (`#1C1916`–`#221E1A`) transitions smoothly without hard banding.
- **Final Acceptance Criteria:**
  - Primary cards across Reader, Profile, and Admin exhibit the subtle 155° mineral gradient and `1px` top-edge specular highlight in both Light and Dark Mode, while recessed wells/tables use sunken inset styling without nested double borders.

---

#### `SYS-03` (P1) — Inverted Primary CTA Hierarchy & Semantic Status Color Misuse

- **Components:**
  - [`client/scss/base/base.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/base/base.scss#L327-L445)
  - [`client/scss/components/v-btn.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/components/v-btn.scss#L81-L108)
  - [`client/components/profile/profile.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile/profile.vue)
  - [`client/components/editor.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor.vue)
  - [`client/components/pwa/offline-library.vue`](file:///home/bbferko/repos/tsEpistle/client/components/pwa/offline-library.vue)
- **Observed Problems:**
  - On `/p/profile`, the top-right primary action `[ ✓ Save changes ]` is a low-contrast muted gray pill, while `[ 🔒 Change Password ]` inside the Authentication card is a high-saturation solid orange pill (`#F9A134`) even when all three password fields are empty.
  - On `/e/en/hot-dog-flavors` (Editor top bar), five adjacent buttons (`✓ Saved`, `Reason`, `Save and close`, `Page`, `Close`) share flat, uniform styling—making `Save and close` visually indistinguishable from `Reason` or `Close`.
  - On `/p/offline`, the `Network` telemetry card displays normal connectivity (`Reports a connection`) in warning amber/orange text (`--wiki-status-warning-ink`), making healthy online status look like a degraded network alert.
- **User Impact:**
  - Users cannot scan a surface in `< 1 second` to locate its primary commitment action, and warning amber loses its semantic meaning when applied to normal states.
- **Specific Corrections:**
  1. Enforce **at most one high-emphasis primary CTA per viewport region** (`Save changes`, `Save and close`, `Send`, `Create`), styled with the warm mineral accent fill (`var(--wiki-accent-warm)`) and dark obsidian ink (`#171512`) when actionable/dirty.
  2. Demote secondary section actions (`Change Password`, `Support report`, `Reset view`) to `variant="tonal"` or `variant="outlined"`; only promote `Change Password` to primary accent when `newPassword` is non-empty.
  3. Reserve `--wiki-status-warning-ink` strictly for genuine warning states; style normal online status (`Reports a connection`) with `--wiki-status-success-ink` (`#1E6F50` light / `#5CE0A8` dark) and a subtle emerald dot indicator.
- **Final Acceptance Criteria:**
  - Every workspace header and modal has a single unambiguous primary CTA, untouched secondary forms do not out-shout page-level save actions, and healthy telemetry states never render in warning amber or error rose.

---

### B. Authentication & Onboarding (`AUTH`)

#### `AUTH-01` (P1) — Desktop Asymmetric Void, Competing Headings & Mobile Card Dead-Space on `/login`

- **Components:**
  - [`client/components/login.vue`](file:///home/bbferko/repos/tsEpistle/client/components/login.vue)
  - [`client/components/common/auth-shell.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/auth-shell.vue)
- **Observed Problems:**
  - On Desktop (`1440×900`, `/login` Light & Dark), the `.auth-card` sits anchored in the lower-left quadrant while the right `55%` of the viewport is an empty beige/charcoal expanse occupied only by a faint particle cloud.
  - Inside `.auth-card`, the brand header `Tim O'Pedia` (`<h1>`) is followed by a second large serif heading `Enter your credentials` (`<h2>`) that competes with the brand title and leaves only `~8px` above the floating `Email Address` label notch.
  - On Mobile (`390×844`, `/login`), `.auth-card` stretches vertically with `~100px` of empty card space between the `Password` field and `SIGN IN`, and another `~90px` of empty card space below `Forgot your password?`.
- **User Impact:**
  - Desktop sign-in feels off-balance and ungrounded; mobile sign-in wastes vertical screen real estate with awkward internal gaps.
- **Specific Corrections:**
  1. In [`client/components/common/auth-shell.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/auth-shell.vue) and [`client/components/login.vue`](file:///home/bbferko/repos/tsEpistle/client/components/login.vue), vertically center the desktop `.auth-card` within a balanced 12-column grid (left 5 columns for the Tier 3 Smoked Quartz Glass `.auth-card`, right 7 columns framing the particle emblem with a subtle archival colophon or workspace tagline anchored bottom-right).
  2. Reduce `Enter your credentials` from a competing display `<h2>` to a single quiet subtitle (`0.9375rem`, `color: var(--wiki-ink-muted)`, `margin-bottom: var(--wiki-space-5)`) directly under `Tim O'Pedia`.
  3. On mobile (`< 600px`), set `.auth-card` height to `auto` (`min-height: unset`) with natural vertical stack spacing (`gap: var(--wiki-space-4)`) so `SIGN IN` sits `20px` below `Password` without dead air.
- **Final Acceptance Criteria:**
  - Desktop `/login` is vertically balanced, `Email Address` has `>= 20px` clearance below the subtitle, and mobile `/login` renders as a compact, self-sized card without interior vertical voids.

---

#### `AUTH-02` (P1) — Forgot-Password Helper Box Mimicking an Input, `scale(NaN)` View-Transition Error & Synchronous WebGL `ReadPixels` Stalls

- **Components:**
  - [`client/components/login.vue`](file:///home/bbferko/repos/tsEpistle/client/components/login.vue#L950-L980)
  - [`client/components/common/LoginParticleLogo.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/LoginParticleLogo.vue)
- **Observed Problems:**
  - Clicking `Forgot your password?` on `/login` (`1440×900`) renders the instructional text (`Enter the email address associated with your account and we'll send you a link to reset your password.`) inside a full-width rounded rectangle with a `1px` border that looks identical to a disabled text input stacked right above `Email Address`.
  - Browser console inspection during `/login` transitions logs:
    - `TypeError: Failed to execute 'animate' on 'Element': Invalid keyframe value for property transform: translate(0px, 0px) scale(NaN)` in [`client/components/login.vue`](file:///home/bbferko/repos/tsEpistle/client/components/login.vue#L964) (caused by FLIP geometry division when `targetRect.width` or `targetRect.height` is `0`).
    - Four consecutive `[.WebGL-...]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels` warnings from [`LoginParticleLogo.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/LoginParticleLogo.vue).
- **User Impact:**
  - Users momentarily mistake the instructional box for a form field, while uncaught `scale(NaN)` exceptions abort the view transition animation and `ReadPixels` stalls delay initial frame interactive readiness.
- **Specific Corrections:**
  1. Remove the input-like border and background box from the Forgot Password instructional paragraph in [`client/components/login.vue`](file:///home/bbferko/repos/tsEpistle/client/components/login.vue); render it as clean body copy (`color: var(--wiki-ink-secondary); line-height: 1.5; margin-bottom: 1.25rem`).
  2. Guard the FLIP keyframe calculation around [`client/components/login.vue`](file:///home/bbferko/repos/tsEpistle/client/components/login.vue#L950-L980): if `!fromRect.width || !fromRect.height || !toRect.width || !toRect.height`, skip the scale transform or fall back to a clean opacity/translate fade (`scale(1)`).
  3. In [`client/components/common/LoginParticleLogo.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/LoginParticleLogo.vue), sample logo alpha/positions via an offscreen 2D canvas (`ctx.getImageData`) or precomputed point buffer rather than calling WebGL `readPixels` on the active GPU context during initialization.
- **Final Acceptance Criteria:**
  - Forgot Password view renders plain instructional prose above `Email Address`, navigating between `/login` states produces `0` console errors, and initial load triggers `0` WebGL `ReadPixels` GPU stalls.

---

### C. Global Shell, Navigation & Wiki Reader (`SHELL`, `READER`)

#### `SHELL-01` (P0) — Dual Adjacent Left Sidebars (`nav-sidebar` + `ON THIS PAGE`) Consuming 33% of Desktop Width & Empty `Main Menu` Tab

- **Components:**
  - [`client/themes/default/components/nav-sidebar.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/nav-sidebar.vue)
  - [`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue)
- **Observed Problems:**
  - On Desktop (`1440×900`, `/en/home`), the `260px` global `nav-sidebar` sits on the far left and is immediately followed by the `220px` `ON THIS PAGE` TOC card (`page-toc-col`) on the left of the article body. Together, these two adjacent vertical lists consume `~480px` (`33.3%` of the viewport) on the left side of the screen, both using warm pill selection indicators that compete visually.
  - Clicking `Main Menu` in the top segmented switcher of `nav-sidebar.vue` reveals an empty panel (`No menu links yet. Switch to Browse to explore pages by folder.`) because no custom navigation items are configured, yet the `Main Menu / Browse` segmented control permanently occupies the top of the sidebar.
- **User Impact:**
  - The reader layout is heavily left-weighted, squeezing article prose and tables while forcing the user's eye to jump across two parallel navigation columns before reaching content.
- **Specific Corrections:**
  1. In [`client/themes/default/components/nav-sidebar.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/nav-sidebar.vue), hide the `Main Menu | Browse` segmented toggle whenever `Main Menu` contains `0` user-visible links (defaulting directly to the `Browse` tree, with an admin-only subtle `+ Configure menu` link in the sidebar footer).
  2. In [`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue), default desktop (`>= 1280px`) article layout to a balanced **3-zone cadence**:
     - **Left Zone (`256px`):** Global Workspace Tree (`nav-sidebar`).
     - **Center Zone (`minmax(0, 76ch)` centered within available canvas):** Article Hero + Editorial Prose.
     - **Right Zone (`224px` sticky rail):** `ON THIS PAGE` Table of Contents (quiet borderless index with a `1px` left guide track).
     - *(If a user explicitly selects `tocPosition = 'left'` in Reading Preferences, auto-collapse the global `nav-sidebar` into a compact drawer or render the TOC as a collapsible inline header disclosure so two expanded left sidebars never sit side-by-side).*
- **Final Acceptance Criteria:**
  - Desktop reader view never displays two expanded vertical navigation rails side-by-side on the left, the article column sits balanced between workspace navigation and the document outline, and `Main Menu` is hidden when empty.

---

#### `SHELL-02` (P1) — Mobile Header Hides Flagship `Wiki Agent` Trigger, Exposes Pointless `Full width` Toggle & Clips `⋮` Overflow Menu

- **Components:**
  - [`client/components/common/nav-header.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/nav-header.vue)
- **Observed Problems:**
  - On Mobile (`390×844`, `/en/home`), the top header shows `[ ≡ ] [ TO Tim O'Pedia ] [ 🔍 ] [ ⋮ ] [ 👤 ]`. The flagship `✨ Wiki Agent` button disappears completely from the top bar.
  - Opening the `[ ⋮ ]` overflow menu (`390×844`) reveals a tall ungrouped list that:
    1. Includes `Full width` (`Switch between a centered reading column and full-width layout`), which has zero effect on a `390px` phone screen.
    2. Clips the bottom item (`Move / Rename — Change this page's path or language`) in half at the bottom edge of the popover.
- **User Impact:**
  - Mobile users lose direct 1-tap access to the core `Wiki Agent` capability and encounter irrelevant or clipped page commands in the overflow menu.
- **Specific Corrections:**
  1. In [`client/components/common/nav-header.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/nav-header.vue), keep the `✨` (`Wiki Agent`) icon button permanently visible in the mobile top bar (next to `🔍`), reclaiming horizontal space on `< 440px` viewports by hiding or compacting the text wordmark `Tim O'Pedia` while keeping the `TO` monogram badge.
  2. Hide the `Full width` toggle inside the `⋮` menu whenever viewport width is `< 1145px`.
  3. Set `max-height: min(72dvh, 420px); overflow-y: auto` on the `⋮` popover menu and group items with subtle `1px` dividers (`Assistant & Layout` | `Page Authoring` | `History & Source`).
- **Final Acceptance Criteria:**
  - On `390×844` mobile viewports, the `✨ Wiki Agent` trigger is directly tappable in the top bar, `Full width` is omitted from the mobile menu, and all `⋮` menu items scroll cleanly without vertical clipping.

---

#### `READER-01` (P0) — Infinite Oscillating TOC Marquee Slicing Headings on Both Ends, Single-Heading TOC Clutter & `47× "0% read"` Accessibility Noise

- **Components:**
  - [`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue#L5888-L5912)
- **Observed Problems:**
  - In [`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue#L5888-L5912), `.page-toc-item-title--marquee` sets `text-overflow: clip` and runs `animation: page-toc-marquee 4s ease-in-out infinite` with a comment stating *"Runs unconditionally so the behavior does not depend on the reduced-motion media query"*.
  - Visually observed across `/_private/en/new2-page` (`"esting the Visual Markdow"`), `/en/contract-interiors-tribute` (`"or the Makers of Meaningfu"`), and `/en/hot-dog-flavors` (`"Building a balanced hot do"`): active TOC headings continuously slide back and forth, slicing characters off both the start and end of the title while ignoring OS reduced-motion preferences.
  - On `/_private/en/new2-page` (which has only 1 heading), the full `220px` `ON THIS PAGE 1` sidebar still renders just to repeat the page title a third time.
  - Scrolling the TOC list on `/en/home` clips the `ON THIS PAGE` header label at the top of the scroll container.
  - In the accessibility tree (`05-home-desktop.yaml`), every single TOC link appends `, 0% read` to its accessible name (`link "General Info |, 0% read"`, repeated 47 times), while the header pill remains frozen at `0% read` even after scrolling to the bottom of the page (`scrollY = 2368px`).
- **User Impact:**
  - The oscillating TOC is a persistent peripheral motion distraction that makes the active section title unreadable and violates WCAG 2.2 SC 2.2.2 (`Pause, Stop, Hide`) and SC 2.3.3 (`Animation from Interactions`). Screen-reader users hear `"zero percent read"` 47 times per page.
- **Specific Corrections:**
  1. **Delete** `.page-toc-item-title--marquee` and `@keyframes page-toc-marquee` from [`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue#L5888-L5912).
  2. Allow active and hovered TOC items to wrap cleanly up to 2 lines (`display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; line-height: 1.35`), and use standard single-line `text-overflow: ellipsis` for inactive items with a native `title` attribute.
  3. Auto-hide the `ON THIS PAGE` rail when `tocItems.length < 2`.
  4. Keep the `ON THIS PAGE` header bar outside `.page-toc-list` (or `position: sticky; top: 0; z-index: 2; background: inherit`) so scrolling the outline never clips the header.
  5. Remove `, 0% read` from individual TOC item `aria-label` attributes, and bind the single header progress indicator to the actual article scroll container (`window` or `.wiki-page` scroll progress).
- **Final Acceptance Criteria:**
  - Zero TOC items oscillate or clip leading characters; pages with `< 2` headings hide the TOC column; `ON THIS PAGE` stays pinned while scrolling long outlines; and reading percentage updates accurately in one place without repeating in every link's `aria-label`.

---

#### `READER-02` (P1) — Coarse-Pointer / Mobile Hero Crushed `2px` Against Top Bar & Staggered Action Wrapping

- **Components:**
  - [`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue#L6779-L6787)
- **Observed Problems:**
  - On Mobile (`390×844`, `/en/home`) and Tablet (`768×1024`, `/en/home`), [`page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue#L6779-L6787) applies `@media (pointer: coarse) and (max-width: 1279px) { .page-header-section > .is-page-header { padding-block: 2px !important; } }`.
  - This crushes the `Homepage |🏘️` `<h1>` to within `2px` of the top navigation bar's bottom border.
  - Simultaneously, the hero actions split awkwardly onto two uneven rows (`[ Focus ] [ Save offline ] [ Share ]` on row 1; `[ Edit ]` dangling below on row 2), followed by a large `~42px` vertical gap before the `LAST EDITED BY` metadata bar.
- **User Impact:**
  - Mobile and tablet article headers look cramped at the top edge and vertically disjointed across action buttons and metadata.
- **Specific Corrections:**
  1. Replace `padding-block: 2px !important` in [`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue#L6779-L6787) with `padding-block: var(--wiki-space-4) var(--wiki-space-3)`.
  2. Arrange mobile/tablet hero actions in a single horizontal flex row (`display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: nowrap`): compact icon+label primary `[ ✏️ Edit ]` pill on the right, and compact tonal pills (`Focus`, `Share`, icon-only `Save offline`) on the left, with `12px` spacing above the metadata strip.
- **Final Acceptance Criteria:**
  - On `390×844` and `768×1024`, the article `<h1>` has `>= 16px` top breathing room below the header bar and all hero actions align on a single clean row.

---

#### `READER-03` (P1) — Focus Mode Spatial Discontinuity & Floating Bottom Dock Occluding Article Prose

- **Components:**
  - [`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue#L6517-L6731)
- **Observed Problems:**
  - Clicking `Focus` in the top-right of the Reader hero (`1440×900`, `/en/home`) deletes the `Focus` button from the hero and spawns a floating bottom-center `.page-reading-dock` (`0% read | 47 sections | Choose section ▾ | ↑ Top | Exit focus`).
  - Because the global top `nav-header` remains 100% visible while `.page-reading-dock` floats directly over the bottom center of the viewport, entering "Focus Mode" actually adds a second persistent chrome bar on top of the article text!
  - Opening `Choose section ▾` inside the dock triggers the `SYS-01` notch line glitch (`Jump to section`).
- **User Impact:**
  - Users lose spatial predictability when the toggle they just clicked vanishes from the top-right corner, and the bottom HUD obscures lines of prose while reading.
- **Specific Corrections:**
  1. Keep a quiet `[ Exit focus · Esc ]` pill in the top-right of the hero (in the exact spot where `Focus` was clicked) in addition to the bottom HUD control.
  2. In `.wiki-page--reading`, add `padding-block-end: 6rem` to the article container and place a `36px` bottom scroll-fade apron (`linear-gradient(to top, var(--wiki-canvas-bg) 40%, transparent)`) beneath `.page-reading-dock` so prose never collides directly with the glass HUD.
  3. Auto-compact or slide up the global top `nav-header` on downward scroll while in Focus Mode (revealing it immediately on upward scroll or cursor proximity to the top edge).
- **Final Acceptance Criteria:**
  - Entering Focus Mode keeps a top-right exit affordance at the activation locus, prevents `.page-reading-dock` from obscuring final article lines, and reduces total chrome height during downward reading.

---

#### `READER-04` (P2) — Consumer Social Bloat in `Share` Modal, Unstyled `Needs Verification` Links & Account Menu `Logout` Icon Drift

- **Components:**
  - [`client/components/common/social-sharing.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/social-sharing.vue)
  - [`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue#L4862-L4920)
  - [`client/components/common/nav-header.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/nav-header.vue)
- **Observed Problems:**
  - Clicking `Share` on `/en/home` opens a modal listing 9 consumer social networks (`Email`, `Facebook`, `Reddit`, `Telegram`, `X`, `Viber`, `Weibo`, `Whatsapp`)—an jarring mismatch for an authenticated private enterprise wiki/memory system.
  - Clicking `Needs Verification` in the page hero opens a popover where `Verify accuracy` and `Refresh verification details` render as raw underlined HTML links with no button affordance or hierarchy.
  - Clicking the top-right Account avatar (`👤`) opens a menu (`Profile`, `Administration`, `Logout`) where `Profile` and `Administration` have leading icons, but `Logout` has no leading icon and instead floats a trailing exit icon `~40px` to the right in mid-air.
- **User Impact:**
  - Consumer social links undermine enterprise trust and risk accidental external sharing attempts; unstyled verification links and misaligned menu icons degrade interface polish.
- **Specific Corrections:**
  1. In [`client/components/common/social-sharing.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/social-sharing.vue), replace the consumer social network list by default with an **Enterprise Citation & Link Popover**:
     - Primary read-only URL field with 1-click `[ Copy link ]`
     - `[ Copy Markdown link ([Title](url)) ]`
     - `[ Copy current section link ]`
     - `[ Share via Email ]`
     *(Only render external social targets if an administrator explicitly enables public social sharing in Admin settings).*
  2. In [`client/themes/default/components/page.vue`](file:///home/bbferko/repos/tsEpistle/client/themes/default/components/page.vue#L4862-L4920), style `Verify accuracy` as a primary tonal button (`v-btn variant="tonal" size="small" prepend-icon="mdi-check-decagram-outline"`) and `Refresh verification details` as a subtle ghost button (`variant="text" size="small" prepend-icon="mdi-refresh"`).
  3. In [`client/components/common/nav-header.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/nav-header.vue), move the `Logout` icon into the standard `prepend-icon` slot aligned with `Profile` and `Administration`.
- **Final Acceptance Criteria:**
  - `Share` provides 1-click URL/Markdown citation copying without consumer social clutter; `Needs Verification` uses structured buttons; and all 3 Account menu items align on a single left icon + label axis.

---

### D. Search Overlay, Source Notebook, Tags & History (`SEARCH`, `TAGS`, `HIST`)

#### `SEARCH-01` (P1) — Self-Dismissing Empty-State CTA, Mid-Row `EN >` Badge & Raw Pilcrows (`¶`) in Source Notebook

- **Components:**
  - [`client/components/common/search-results.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/search-results.vue)
  - [`client/components/common/wiki-source-preview.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/wiki-source-preview.vue)
- **Observed Problems:**
  - Pressing `Ctrl+K` or clicking the header search bar (`1440×900`, `/en/home`) opens the Search modal with an empty card (`Start with a page title or phrase`) whose sole button is `[ Browse current view ]`—which simply closes the modal the user just opened.
  - Typing a query (`"Welcome"`, `19-search-results.png`) renders result rows where `EN >` floats in the horizontal middle of the row without alignment, and the trailing `[ Preview ]` button has a dark high-contrast outline that overpowers the result title.
  - Clicking `[ Preview ]` (`20-search-preview.png`) opens the right-hand `SOURCE NOTEBOOK` pane (`wiki-source-preview.vue`), where:
    1. Every heading renders with a raw visible pilcrow prefix (`¶ General Info |`, `¶ 2/90 Signs`, `¶ Account Responsibility`) because `.toc-anchor` is not hidden inside `wiki-source-preview.vue`.
    2. In the sticky footer, the disclaimer `Ask prepares a draft. Nothing is sent.` sits on the far left directly beneath `Open page ↗`, while the `[ Ask about this page ]` button it describes sits on the far right.
- **User Impact:**
  - `Ctrl+K` offers zero immediate navigation utility before typing; result rows scan poorly; and raw `¶` symbols make the Source Notebook look like unstyled parser output.
- **Specific Corrections:**
  1. In [`client/components/common/search-results.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/search-results.vue), replace the empty-state `[ Browse current view ]` button with a **Recent Pages & Quick Actions** list (`Recent pages`, `✨ Ask Wiki Agent`, `➕ Create page`, `🏷️ Browse by tags`).
  2. In search result rows, tuck the locale/path badge (`en / home`) neatly inline under or beside the title in monospace muted ink (`--wiki-ink-muted`), and style `[ Preview ]` as a quiet ghost/tonal pill (`variant="tonal" size="small"`) that intensifies on row hover.
  3. In [`client/components/common/wiki-source-preview.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/wiki-source-preview.vue), add `:deep(.toc-anchor) { display: none; }` to suppress raw `¶` markers, and move `Ask prepares a draft. Nothing is sent.` so it sits right-aligned directly below `[ Ask about this page ]` (or inside its tooltip).
- **Final Acceptance Criteria:**
  - Opening Search immediately surfaces recent pages and quick actions; result rows have clean left-to-right hierarchy; and `SOURCE NOTEBOOK` renders zero visible `¶` characters with aligned footer helper copy.

---

#### `TAGS-01` (P1) — Missing Global Left Sidebar on `/t`, 5-Tier Heading Redundancy & Misaligned Filter Controls

- **Components:**
  - [`client/components/tags.vue`](file:///home/bbferko/repos/tsEpistle/client/components/tags.vue)
- **Observed Problems:**
  - Navigating to `/t` (`Browse by Tags`, `1440×900`) drops the global left navigation sidebar (`nav-sidebar`) completely, breaking spatial continuity with the rest of the wiki.
  - The top of `/t` stacks **five redundant headings/kickers** in sequence:
    1. `EDITORIAL LIBRARY`
    2. `Browse by Tags` (`<h1>`)
    3. `Filter the library by selecting one or more tags...`
    4. `BROWSE THE VOCABULARY`
    5. `Tag index` (`<h2>`) + `Browse the alphabetical tag index and combine topics...`
  - Selecting a tag (`42b-browse-tags-selected.png`) reveals the `MATCHING PAGES` filter toolbar where three adjacent controls sit on three different vertical baselines:
    - `Search within results...` stretches to `~80px` tall because an empty helper-details row is reserved below the input.
    - `Order By` renders as an external label *above* the `Title ▾` select box, pushing the select box downward.
    - The sort direction buttons `[ ↓= ] [ ↑= ]` align to the top of the row.
- **User Impact:**
  - Users lose their global folder navigation when browsing tags, must scroll past repetitive titles, and encounter a visually broken filter bar.
- **Specific Corrections:**
  1. Render `/t` inside the standard wiki shell with `nav-sidebar` preserved on the left.
  2. Collapse the 5-tier header stack into a single compact header (`Browse by Tags` `<h1>` + inline count badge `18 tags` + 1-line subtitle), removing the duplicate `BROWSE THE VOCABULARY / Tag index` wrapper header.
  3. In the `MATCHING PAGES` toolbar of [`client/components/tags.vue`](file:///home/bbferko/repos/tsEpistle/client/components/tags.vue), add `hide-details` and `density="compact"` to both `Search within results...` and the `Order By` `v-select` (using an inline floating/prefix label `Order by: Title`), and align the search input, select, and sort-direction segmented toggle to a single `40px` height and shared center baseline.
- **Final Acceptance Criteria:**
  - `/t` retains the global left sidebar, displays a single concise page header, and aligns all filter/sort controls on an exact `40px` horizontal row.

---

#### `HIST-01` (P2) — Off-by-One Revision Counter & Yellow Deletion Diff Highlight in Page History

- **Components:**
  - [`client/components/history.vue`](file:///home/bbferko/repos/tsEpistle/client/components/history.vue#L1745-L1775)
- **Observed Problems:**
  - On `/h/en/home` (`Page History`, `1440×900`, `44-page-history.png`), the left sidebar header states `3 revisions` while rendering **4** revision cards in the list below (`Oct 16, 2025`, `Sep 14, 2025`, `Sep 11, 2025`, `Sep 8, 2025`).
  - In the right-hand diff viewer (`Diff`), removed lines (`86 -`) are highlighted in warm yellow/amber (`color-mix(in oklch, var(--wiki-status-warning)...)`), which reads as a search highlight or warning rather than a semantic deletion against the green addition lines (`86 +`).
- **User Impact:**
  - The mismatched revision count erodes trust in version history accuracy, and yellow deletion lines slow down visual diff scanning.
- **Specific Corrections:**
  1. In [`client/components/history.vue`](file:///home/bbferko/repos/tsEpistle/client/components/history.vue), bind the header counter to the actual displayed revision list length (`trail.length`) or clearly label it `4 revisions (3 historical changes)` so the count matches the rendered items.
  2. In [`client/components/history.vue`](file:///home/bbferko/repos/tsEpistle/client/components/history.vue#L1755-L1770), change `.history-diff-line--removed` background and gutter marker from warning yellow to semantic deletion rose (`color-mix(in oklch, var(--wiki-status-error-surface) 65%, transparent)` and `--wiki-status-error-ink`).
- **Final Acceptance Criteria:**
  - The revision count badge matches the number of rendered revision rows, and deleted lines in `Diff` render in semantic rose against emerald additions.

---

### E. Wiki Agent + Memory Workspace (`AGENT`)

#### `AGENT-01` (P0) — Quadruple Context Duplication, Nested `<button>` HTML Violation & 6-Row Composer Control Soup

- **Components:**
  - [`client/components/agents/inline-agent-chat.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/inline-agent-chat.vue#L2287-L2340)
  - [`client/components/agents/agent-composer.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-composer.vue)
  - [`client/components/agents/agent-context-summary.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-context-summary.vue)
- **Observed Problems:**
  - Inspected in the `Wiki Agent` workspace (`1440×900`, `21-search-inline-agent.png` and accessibility tree `21-agent-workspace.yaml`):
    1. **Duplicate Context Summary Regions:** [`agent-context-summary.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-context-summary.vue) (`Sources 1/8 · Current page included · You · 0 ch · Agent · 0 ch · [ Context details ]`) is rendered at the top of the workspace (`inline-agent__context-header`) AND rendered **a second time verbatim inside the bottom composer card** (`agent-composer`). Both expose `region "Conversation context"` in the accessibility tree.
    2. **Quadruple Current-Page Redundancy:** Before the user types a single word, `Homepage |🏘️` is announced **4 times** in the same modal:
       - Top context bar (`Current page included`)
       - Composer context bar (`Current page included`)
       - Composer source toggle row (`[ Homepage |🏘️ Included ✓ ]`)
       - Composer attached source chip row (`[ 📄 Homepage |🏘️ 👁️ ✖ ]`)
    3. **Invalid Nested `<button>` Markup:** In the accessibility tree (`21-agent-workspace.yaml`), the attached source pill renders a `<button "Remove source: Homepage |🏘️ (en/home)">` **nested inside** `<button "Preview attached source: Homepage |🏘️ (en/home)">`, violating the HTML5 specification and breaking keyboard/screen-reader activation.
    4. **6-Row Composer Stack:** The composer stacks 6 distinct rows of pills, counters, chips, textarea, and action buttons (`+ Add page`, `📎 Attach`, `📄 Create`, `</> Skills`, `🔧 My tools`, `🎯 Goal mode`, `🎤`, `Send`), consuming `~240px` of vertical height.
- **User Impact:**
  - The composer looks overwhelmingly busy and repetitive, steals vertical space from the conversation thread, and contains invalid nested interactive controls.
- **Specific Corrections:**
  1. Remove the duplicate `<agent-context-summary>` instance from inside [`client/components/agents/agent-composer.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-composer.vue), keeping only a single context summary strip in the workspace header (or a single compact pill inside the composer).
  2. Collapse the current-page toggle (`[ Homepage Included ✓ ]`) and attached source chip (`[ 📄 Homepage 👁️ ✖ ]`) into **one unified source chip row** inside the composer, where each source chip is a non-button container (`role="group"`) housing two sibling buttons: a primary label button (`Preview source`) and a trailing icon button (`Remove source`).
  3. Streamline [`agent-composer.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-composer.vue) into **at most 2 clean rows** (plus an optional compact chip strip when sources/attachments are present):
     - **Row 1:** Auto-expanding prompt textarea (`Ask about this page or your workspace...`).
     - **Row 2 (Unified Footer Bar):** Left cluster (`[ 📄 Homepage ✓ ✖ ]`, `[ + Source ]`, `[ 📎 Attach ]`, `[ ⚡ Capabilities ▾ ]` consolidating Skills, My Tools & Create, and `[ 🎯 Goal ]` toggle pill) + Right cluster (`[ 🎤 ]` + primary `[ Send ↵ ]`).
- **Final Acceptance Criteria:**
  - Only one `Conversation context` summary region exists in the DOM; the active page name appears once as a unified interactive chip; zero `<button>` elements are nested inside other `<button>` elements; and the resting composer height is `<= 132px`.

---

#### `AGENT-02` (P0) — Ghosted Composer Double-Exposure Over Transcript Prose & Translucent `↓ Latest` Pill

- **Components:**
  - [`client/components/agents/inline-agent-chat.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/inline-agent-chat.vue#L3040-L3120)
  - [`client/components/agents/agent-thread.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-thread.vue)
- **Observed Problems:**
  - When scrolling up to read an existing or newly generated conversation (`1440×900`, `33c-agent-thread-real-top.png` and `34c-agent-thread-real-mid.png`), `inline-agent-chat.vue` switches the bottom composer dock into a low-opacity ghosted state (`opacity ~0.2`) while allowing the scrolling transcript text (`1. Brand & Identity Updates`, bullet points, and citations) to render directly **through and behind** the ghosted composer buttons and inputs!
  - Similarly, the floating `[ ↓ Latest ]` button renders with a semi-transparent fill directly over bullet text without sufficient contrast or elevation separation.
- **User Impact:**
  - The bottom `210px` of the conversation viewport becomes a visually chaotic double-exposure where neither the article prose nor the composer controls can be read cleanly.
- **Specific Corrections:**
  1. In [`client/components/agents/inline-agent-chat.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/inline-agent-chat.vue#L3040-L3120), **remove the semi-transparent ghosted-composer overlay behavior**. Either:
     - Keep the composer in its own dedicated flex footer below the transcript scroll container (never overlapping transcript text), **or**
     - When `transcriptFollowing === false`, smoothly collapse the composer into a solid, opaque `52px` single-line pill dock (`Ask a follow-up...`) backed by a `32px` opaque-to-transparent scroll-fade apron (`linear-gradient(to top, rgb(var(--v-theme-surface)) 75%, transparent)`).
  2. Style the floating `[ ↓ Latest ]` button as an opaque elevated pill (`background: var(--wiki-surface-raised); border: 1px solid var(--wiki-accent-warm); box-shadow: var(--wiki-shadow-md)`) positioned `12px` above the collapsed dock.
- **Final Acceptance Criteria:**
  - Scrolling anywhere in an Agent thread never renders transcript text underneath semi-transparent composer controls; all visible transcript lines remain 100% unobstructed.

---

#### `AGENT-03` (P0) — Scroll-Follow Trap on History Open, Mid-Heading Viewport Slicing & Stale `"New chat"` Header State

- **Components:**
  - [`client/components/agents/inline-agent-chat.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/inline-agent-chat.vue#L1848-L1888)
- **Observed Problems:**
  - Opening an existing conversation from `History` (`"Give me a concise catch-up..."`, `25-agent-existing-conv.png`) immediately jumps `scrollTop` to the bottom (`3172px`), slicing the `Evidence limits` subheading horizontally in half at the top edge of the viewport and hiding the user's question and the first 80% of the response.
  - Because [`scheduleTranscriptFrame`](file:///home/bbferko/repos/tsEpistle/client/components/agents/inline-agent-chat.vue#L1848-L1888) calls `scrollTranscriptToBottom()` whenever `transcriptFollowing.value && !transcriptReadingIntent.value`, and focusing the composer (`handleComposerFocusIn`) resets `transcriptReadingIntent`, users who scroll up to inspect a long response can have their scroll position yanked back to the bottom.
  - In Dark Mode (`83-dark-agent.png`), reopening the `Wiki Agent` modal shows `New chat`, `Sources 0/8`, and `Current page excluded` in the top bar while simultaneously rendering the previous conversation's `Partial answer` card in the body below.
- **User Impact:**
  - Users opening past conversations land at the footer disclaimer instead of the answer, fight automatic scroll snapping when reading long outputs, and see contradictory header vs. thread state.
- **Specific Corrections:**
  1. In [`client/components/agents/inline-agent-chat.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/inline-agent-chat.vue#L1848-L1888), when loading a historical/completed conversation, scroll to the **top of the latest assistant message** (or `scrollTop = 0`) and set `transcriptFollowing.value = false`. Reserve automatic bottom-following strictly for active token streaming when the user has not scrolled upward.
  2. Do not reset `transcriptReadingIntent` or force `scrollTranscriptToBottom()` merely because the user focuses the composer input; only scroll to bottom when the user **submits** a new message or explicitly clicks `[ ↓ Latest ]`.
  3. Synchronize the workspace header state (`activeConversation.title`, `Sources` count) with the active thread buffer on modal re-open so a `New chat` header never coexists with a stale `Partial answer` body.
- **Final Acceptance Criteria:**
  - Selecting a conversation from `History` positions the viewport at the start of the conversation/turn without slicing headings; scrolling up stays locked until the user clicks `↓ Latest` or sends a message; and header state always matches the displayed transcript.

---

#### `AGENT-04` (P1) — Raw System Prompt Template Shown as User Bubble, Detached Citation Numbers & Cryptographic Hashes in `Context details`

- **Components:**
  - [`client/components/agents/inline-agent-chat.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/inline-agent-chat.vue)
  - [`client/components/agents/agent-markdown.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-markdown.vue#L860-L910)
  - [`client/components/agents/agent-context-summary.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-context-summary.vue)
- **Observed Problems:**
  - Clicking the `"Catch up"` starter chip (`33c-agent-thread-real-top.png`) submits a 25-line prompt-engineering template (`# Goal ... ## Return Format ... ## Warnings: Cite every non-obvious claim with exact wiki page paths... ## Context Dump`) and renders that entire raw template verbatim as the user's chat bubble, pushing the assistant's response off the first screen.
  - Inside the assistant's markdown response (`34c-agent-thread-real-mid.png`), citation pills (`2`, `3`, `4`, `5`) render on their own standalone block lines `~24px` above each numbered section heading (`1. Brand & Identity Updates`, `2. Core Documentation & Operational Standards`) instead of inline with the text or heading they cite.
  - Clicking `[ Context details ]` (`23-agent-context-details.png`) displays raw 64-character SHA-256 hex strings (`Frozen session snapshot: c6073f5b28b933b419b0b12a7e5a8d1a832d275498b44c98ee44483f7922777c` and `Frozen memory fingerprint: 23d263ad...` repeated twice under both `Session context` and `Memory`).
- **User Impact:**
  - Exposing internal prompt-engineering scaffolding and raw SHA-256 hashes makes the assistant feel like a developer debug harness rather than an executive knowledge partner, while detached citation numbers break reading flow.
- **Specific Corrections:**
  1. When a user triggers a preset starter action (`Catch up`, `Summarize page`, `Find gaps`), store or tag the message with its preset label and render a compact user intent bubble (`✨ Catch up on recent workspace changes — Homepage |🏘️`) with a subtle `Show full prompt ▾` disclosure for power users.
  2. In [`client/components/agents/agent-markdown.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-markdown.vue#L860-L910), ensure citation badges (`button.agent-citation`) and heading elements never split across block boundaries: keep citations `display: inline-flex; vertical-align: baseline` inside paragraph/heading flows, and strip or merge stray paragraph breaks immediately preceding a citation token in the markdown serializer.
  3. In [`client/components/agents/agent-context-summary.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-context-summary.vue), replace raw 64-char SHA-256 strings in the primary `Context details` view with human-meaningful metadata (`Session snapshot locked · Just now`, visual token/character capacity bar `0 / 32,000 chars`, and deduplicated memory status), tucking the cryptographic hash behind a small `[ Copy snapshot ID ]` icon button.
- **Final Acceptance Criteria:**
  - Preset starter chips render as concise 1-line user intent bubbles; citation badges sit inline with the sentence or heading they reference; and `Context details` displays human-readable status and capacity bars without raw 64-character hex dumps.

---

#### `AGENT-05` (P1) — `My skill library` `360px`-Tall Stretched Search Box & `My tools` Triple-Stacked Warning Banners

- **Components:**
  - [`client/components/agents/agent-personal-skills.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-personal-skills.vue#L680-L715)
  - [`client/components/agents/agent-personal-mcp.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-personal-mcp.vue)
- **Observed Problems:**
  - In `My skill library` (`35-agent-manage-skills.png`, opened via `Skills -> Manage skills`), the left column (`available skills`) is a flex/grid container where `.personal-inventory__search` (`Filter by name, summary, or status`) stretches vertically to **`~360px` tall**, turning a single-line filter input into a giant empty rectangle and pushing `No personal skills match this filter.` to the bottom edge.
  - In `My tools` (`32-agent-my-tools.png`), the dialog stacks a 4-line legalistic disclaimer paragraph, two separate amber warning banners (`Personal MCP tools are unavailable...` and `Personal external MCP connections are disabled...`), AND a red error banner (`Personal MCP tools are turned off by an administrator.`) before finally rendering `No enabled external servers are available.`
- **User Impact:**
  - `My skill library` looks broken due to the giant stretched input box, and `My tools` bombards the user with four redundant explanations of the exact same disabled state.
- **Specific Corrections:**
  1. In [`client/components/agents/agent-personal-skills.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-personal-skills.vue#L680-L715), set `flex: 0 0 auto` (and `align-content: start` on the left pane container) for `.personal-inventory__search` so the filter input remains `40px` tall and the skill list / empty state fills the remaining height cleanly.
  2. In [`client/components/agents/agent-personal-mcp.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-personal-mcp.vue), consolidate the disabled state into **one single calm informational card** (`Personal MCP tools are currently disabled by your workspace administrator.`) with a single link/button to `View workspace agent settings` (if admin) or `Close`.
- **Final Acceptance Criteria:**
  - The search field in `My skill library` is `40px` tall; `My tools` displays at most one unified status banner when disabled by an administrator.

---

### F. Page Authoring & Editors (`EDIT`)

#### `EDIT-01` (P0) — Visual Markdown (`editor-tiptap.vue`) 3-Row `144px` Top Chrome, Outlined Active Paragraph Box & Unstyled Native Slash Menu (`/`)

- **Components:**
  - [`client/components/editor/tiptap/editor.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/tiptap/editor.vue)
- **Observed Problems:**
  - Switching a page to **Visual Markdown** (`1440×900`, `/_private/en/new2-page`, `53-visual-markdown-canvas.png` & `53b-visual-markdown-slash.png`) reveals three critical authoring flaws:
    1. **3 Full-Width Chrome Bars (`144px` vertical height):** Row 1 (`56px` global editor bar), Row 2 (`48px` formatting toolbar), and Row 3 (`40px` full-width bar dedicated solely to `⊕ INSERT | Content | Admonition | Definition list | Icon & emoji ▾`).
    2. **Heavy Input Border Around Active Prose Paragraphs:** Clicking or typing inside a body paragraph draws a dark `1px` rectangular box around the entire paragraph block (`53b-visual-markdown-slash.png`), making an editorial document feel like a stack of form textareas.
    3. **Unstyled Native Slash Menu (`/`):** Typing `/` opens a slash command menu rendered as a stack of raw rectangular `<button>` elements with hard black `1px` borders, zero leading icons, zero markdown shortcut hints, and `Task list` sliced in half at the bottom edge of the container (`53b-visual-markdown-slash.png`).
- **User Impact:**
  - The Visual Markdown editor—meant to be the most approachable modern authoring surface—looks unfinished and visually jarring compared to Notion, Linear, or Tiptap flagship editors.
- **Specific Corrections:**
  1. Merge the Row 3 `⊕ INSERT` bar into Row 2 of [`client/components/editor/tiptap/editor.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/tiptap/editor.vue) as a compact `+ Insert ▾` dropdown/pill group (`Content block`, `Admonition`, `Definition list`, `Icon & emoji`), reclaiming `40px` of vertical canvas height.
  2. Remove the rectangular border/outline around focused prose paragraphs in `.ProseMirror` (use a subtle `2px` left margin indicator on block hover/focus if block affordance is needed, keeping the prose canvas borderless).
  3. Redesign the `/` slash command popover in [`client/components/editor/tiptap/editor.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/tiptap/editor.vue) as a **Tier 3 Smoked Quartz Glass** floating menu (`min-width: 260px; max-height: 320px; overflow-y: auto; padding: 6px; border-radius: 12px; box-shadow: var(--wiki-shadow-lg)`):
     - Remove all borders from individual slash menu buttons (`border: none; border-radius: 8px; padding: 8px 10px`).
     - Add a `28×28px` tonal icon badge on the left, item title in the center, and monospace markdown shortcut hint (`H2`, `H3`, `-`, `1.`, `[]`, `>`) on the right, with a warm mineral highlight (`var(--wiki-accent-subtle)`) on the active/selected item.
- **Final Acceptance Criteria:**
  - Visual Markdown uses at most 2 top bars (`<= 104px` total), focused paragraphs have no rectangular box outline, and typing `/` opens a borderless-item glass command menu with icons, shortcut hints, and zero clipped items.

---

#### `EDIT-02` (P1) — Duplicate Tag Icon Navigation Trap, 5 Flat Equal-Weight Header Actions & Wireframe `Contents` Outline Pane

- **Components:**
  - [`client/components/editor.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor.vue)
  - [`client/components/editor/editor-contents-pane.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/editor-contents-pane.vue)
- **Observed Problems:**
  - In the Editor top header (`1440×900`, `/e/en/hot-dog-flavors`, `46-editor-main.png`):
    1. **Two Identical Tag Icons (`🏷️`) with Opposite Behaviors:** On the left side of the top bar (next to the search bar), a `[ 🏷️ ]` icon button navigates away from the editor to `/t` (`Browse by Tags`). On the right side of the same bar, `[ 🏷️ Page ]` opens the `Page Properties` modal. An author clicking the left tag icon to tag their article is navigated out of the editor!
    2. **5 Flat Equal-Weight Buttons:** `✓ Saved`, `Reason`, `Save and close`, `Page`, and `Close` render as 5 adjacent low-contrast pills with no visual distinction between status telemetry (`✓ Saved`), metadata modals (`Reason`, `Page`), primary save (`Save and close`), and exit (`Close`).
  - Opening the `Contents` drawer (`48-editor-contents-pane.png`, [`editor-contents-pane.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/editor-contents-pane.vue)) renders `Top`, `End`, `6`, and every heading item inside heavy `1px` wireframe boxes.
- **User Impact:**
  - Authors risk accidentally leaving the editor via the left tag button, cannot distinguish the primary `Save and close` action at a glance, and see a boxy wireframe outline drawer.
- **Specific Corrections:**
  1. Hide the global `Browse by Tags` (`🏷️`) navigation icon in the top header while on `/e/*` authoring routes, and change the `[ Page ]` button icon in [`client/components/editor.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor.vue) from `mdi-tag` to `mdi-tune-variant` or `mdi-file-cog-outline` (`Page properties`).
  2. Separate the right-hand editor controls into clear semantic tiers:
     - Quiet text/dot status indicator: `● Saved` (not styled as a button).
     - Secondary grouped pill cluster: `[ Page properties ]` · `[ Change note ]`.
     - Primary accent CTA: `[ Save and close ]` (`var(--wiki-accent-warm)` fill) alongside a subtle ghost `[ Close ]` button.
  3. In [`client/components/editor/editor-contents-pane.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/editor-contents-pane.vue), strip the `1px` rectangular borders from heading items and `Top`/`End` pills, styling the outline to match the clean borderless Reader TOC with indentation by heading level (`H1`–`H3`).
- **Final Acceptance Criteria:**
  - Only one unambiguous `Page properties` control exists in the editor header, `Save and close` is visually primary while `Saved` is a non-button status indicator, and the `Contents` pane uses borderless hierarchical list items.

---

#### `EDIT-03` (P1) — `Page Properties`, `Insert Assets`, `Insert Content Extension` & `Select New Page Location` Modal Defects

- **Components:**
  - [`client/components/editor/editor-modal-properties.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/editor-modal-properties.vue)
  - [`client/components/editor/editor-modal-media.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/editor-modal-media.vue)
  - [`client/components/editor/editor-modal-blocks.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/editor-modal-blocks.vue)
  - [`client/components/common/page-selector.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/page-selector.vue)
- **Observed Problems:**
  1. **`Page Properties` (`47-editor-page-properties.png`, `52b-properties-scrolled.png`, `52c-properties-knowledge.png`):**
     - `Tags` is hidden below the fold at the bottom of the `Info` tab, forcing authors to scroll past disabled `Path` and `Locale` fields just to add a tag.
     - Nine static field helper strings expose `role="alert"` in the accessibility tree (`47-page-properties.yaml`), causing screen readers to announce 9 alerts simultaneously on modal open.
     - On the `Knowledge` tab (`52c-properties-knowledge.png`), scrolling clips the `Extension JSON` label under the sticky tab bar, and `[ Apply extensions ]` inside the card duplicates `[ ✓ Apply ]` in the modal footer.
  2. **`Insert Assets` (`49-editor-insert-assets.png`):**
     - When `Insert Assets` opens over the Markdown editor, CodeMirror line 1 (`1 # Hot Dog Flavors`) bleeds visually above the modal header.
     - The left `Upload Assets` dropzone repeats the word `"Browse"` 3 times in `40px` (`Drag & Drop your files or Browse` + `[ ☁️ Browse ]` + `Browse for files to upload`) and displays third-party branding (`Powered by FilePond`).
     - In the bottom footer, `[ ✖ Close ]` is styled identically to action buttons.
  3. **`Insert content extension` (`50-editor-insert-blocks.png`):**
     - Opens a `1440×900` fullscreen dialog (`85%` empty beige space) just to house a single disabled dropdown (`Content extension`) and an empty note box.
  4. **`Select New Page Location` (`17-new-page-modal.png`):**
     - Displays contradictory footer text `Select a page to continue.` while the `Page path` input is already populated with `new-page` and `[ ✓ Select ]` is enabled.
     - Pairs an unstyled borderless `en ▾` locale dropdown directly beside a heavily bordered `Page path` text field.
- **User Impact:**
  - Core authoring modals suffer from buried high-frequency fields (`Tags`), screen-reader alert spam, z-index bleed-through, third-party watermark clutter, and oversized modal footprints.
- **Specific Corrections:**
  1. In [`editor-modal-properties.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/editor-modal-properties.vue): move `Tags` directly below `Short Description` on the `Info` tab (above the fold); remove `role="alert"` from static field hints; add `padding-top: 16px` below the sticky tab bar on `Knowledge`; and remove the duplicate interior `[ Apply extensions ]` button in favor of the single modal footer `[ Apply ]` CTA.
  2. In [`editor-modal-media.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/editor-modal-media.vue): ensure the dialog scrim covers the full viewport (`z-index` above `.editor-toolbar` / CodeMirror); set `credits: false` on FilePond to remove `Powered by FilePond`; and simplify the upload box to a single clean dropzone without redundant `[ Browse ]` buttons.
  3. In [`editor-modal-blocks.vue`](file:///home/bbferko/repos/tsEpistle/client/components/editor/editor-modal-blocks.vue): change the modal from fullscreen to a centered `max-width: 680px` dialog.
  4. In [`page-selector.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/page-selector.vue): dynamically update the footer status to `Ready to create /en/new-page` when a valid path is present, and unify the `Locale` select and `Page path` input into a single joined input group with matching `44px` height and shared border radius.
- **Final Acceptance Criteria:**
  - `Tags` is visible without scrolling in `Page Properties` with `0` static `role="alert"` nodes; `Insert Assets` shows no CodeMirror bleed-through or `FilePond` credits; `Insert content extension` is a compact centered dialog; and `Select New Page Location` displays accurate path status.

---

### G. User Profile & Personal Workspace (`PROF`)

#### `PROF-01` (P1) — Severe 2-Column Vertical Imbalance (`1,500px` Blank Left Void), Cramped MCP JSON Card & Duplicate Workspace Header

- **Components:**
  - [`client/components/profile.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile.vue)
  - [`client/components/profile/profile.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile/profile.vue#L1161-L1265)
- **Observed Problems:**
  - On `/p/profile` (`1440×900`, `54-profile-main.png`, `54b-profile-mid.png`, `54c-profile-bottom.png`, `85-dark-profile.png`):
    1. **Duplicate Header Identity:** The left sidebar header displays `[👤] YOUR WORKSPACE / Profile / Manage your account...` while the main content header immediately beside it repeats `[👤] YOUR WORKSPACE / Profile / Account details, reading defaults...`.
    2. **`1,500px` Blank Left Column & Cramped Right Column:** The layout splits into a 7-column left stack (`My Info`, `Preferences`, `Reading preferences`, ending at `y ≈ 950px`) and a 5-column right stack (`Profile avatar`, `Authentication`, `MCP access keys`, `External MCP connections`, extending down to `y ≈ 2,450px`). Scrolling past `y = 950px` leaves the entire left 60% of the screen completely blank for `1,500px` while squeezing complex developer tables (`Active keys`, `MCP client` JSON configuration snippet, and `External MCP connections`) into the narrow 5-column right rail where `"url": "https://agents8c48g.tail41a24a.ts.net:10443/mcp"` clips horizontally!
- **User Impact:**
  - Half the screen is wasted white space while developer MCP keys and JSON snippets are crushed into a narrow sidebar column.
- **Specific Corrections:**
  1. In [`client/components/profile.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile.vue), remove the duplicate `[👤] YOUR WORKSPACE` icon/kicker from the main content pane header when the left sidebar is visible.
  2. In [`client/components/profile/profile.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile/profile.vue#L1161-L1265), rebalance the layout so the top identity/preferences cards (`My Info` + `Profile avatar & Authentication`, `Preferences` + `Reading preferences`) sit in balanced 2-column rows, while **`MCP access keys`** and **`External MCP connections`** span the **full 12-column width** below them (putting the key creation form on the left 5 columns and the `MCP client` JSON snippet + `Active keys` list on the right 7 columns).
- **Final Acceptance Criteria:**
  - Scrolling `/p/profile` leaves zero single-column vertical voids `> 200px`, the `MCP client` JSON snippet displays full URLs without horizontal clipping, and the workspace header is not duplicated.

---

#### `PROF-02` (P2) — `Notifications` `700px` Unassisted Checkbox Span, `Offline access` Typography/Action Mismatch & Bare Empty States on `/p/notes` and `/p/discussions`

- **Components:**
  - [`client/components/profile/profile-notifications.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile/profile-notifications.vue)
  - [`client/components/pwa/offline-library.vue`](file:///home/bbferko/repos/tsEpistle/client/components/pwa/offline-library.vue)
  - [`client/components/profile/profile-notes.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile/profile-notes.vue)
  - [`client/components/profile/profile-comments.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile/profile-comments.vue)
- **Observed Problems:**
  - On `/p/notifications` (`58-profile-notifications.png`), event descriptions sit on the far left while the `In-App` and `Email` checkboxes sit `~700px` away on the far right with no row hover highlight, no dotted leader, and no "Select all" column header toggles.
  - On `/p/offline` (`59-profile-offline.png`), `Saved pages` inside the lower card uses a `32px` `<h1>`-scale serif font that matches the page title; the page row concatenates `en/home · Updated Oct 16, 2025, 2:10 PM · Cached May 25, 2026, 2:24 AM · Complete · Up to date` into a single dense string; and `[ Open page ]` (bordered button) clashes with `Remove page` (thick underlined link).
  - On `/p/notes` (`56-profile-notes.png`) and `/p/discussions` (`57-profile-discussions.png`), empty states render as bare unformatted sentences (`No live notes yet.`, `No readable contributions to show.`) floating in empty cards.
- **User Impact:**
  - Users risk checking the wrong notification row across a `700px` visual jump, and secondary profile tabs feel visually inconsistent.
- **Specific Corrections:**
  1. In [`profile-notifications.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile/profile-notifications.vue), constrain the notification matrix to `max-width: 760px`, add row hover background (`var(--wiki-surface-elevated)`), and add column-header toggle switches for `In-App` and `Email`.
  2. In [`offline-library.vue`](file:///home/bbferko/repos/tsEpistle/client/components/pwa/offline-library.vue), scale `Saved pages` to standard section heading size (`1.25rem`), split cached page metadata into a clean path badge (`en/home`), status pill (`Up to date`), and relative timestamp, and style `Remove page` as a quiet ghost button (`variant="text" color="error" size="small"`).
  3. In [`profile-notes.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile/profile-notes.vue) and [`profile-comments.vue`](file:///home/bbferko/repos/tsEpistle/client/components/profile/profile-comments.vue), wrap empty states in a centered Tier 2 sunken well with an icon badge, 1-line explanation, and a direct CTA (`Open a page to take notes` / `Browse pages`).
- **Final Acceptance Criteria:**
  - Notification rows highlight on hover within a `<= 760px` container, `Offline access` uses consistent card typography and button variants, and `/p/notes` + `/p/discussions` render structured empty states.

---

### H. Administration Workspace (`ADMIN`)

#### `ADMIN-01` (P0) — Admin Left Sidebar Never Expands or Highlights the Active Route Outside `/a` & Triple Redundant `"Back to Wiki"` Controls

- **Components:**
  - [`client/components/admin.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin.vue)
  - [`client/components/common/nav-header.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/nav-header.vue)
- **Observed Problems:**
  - Inspected across all 21 Administration sub-routes (`/a/general`, `/a/navigation`, `/a/pages`, `/a/pages/recycle-bin`, `/a/pages/integrity`, `/a/pages/visualize`, `/a/tags`, `/a/assets`, `/a/theme`, `/a/groups`, `/a/users`, `/a/analytics`, `/a/auth`, `/a/agents`, `/a/search`, `/a/storage`, `/a/security`, `/a/system`, `/a/utilities`, `/a/webhooks`, `/a/dev-flags`):
    1. **Zero Active Route Highlighting in Sidebar:** Whenever an admin navigates to any sub-route (e.g., `/a/general` or `/a/agents`), all 5 sidebar accordion groups (`Knowledge ⌄`, `People & access ⌄`, `Intelligence & connections ⌄`, `Workspace ⌄`, `Operations ⌄`) remain collapsed (or lose active state) while `Dashboard` at the top of the sidebar retains a permanent rectangular border box! Looking at the sidebar gives zero indication of which admin page is currently open.
    2. **Triple Redundant Exit Controls:** On `/a` (`60-admin-dashboard.png`), the user is presented with three separate "return to wiki" controls simultaneously: an unlabeled, off-center `[ ⇥ ]` icon button in the top-right header (`Exit`), `[ 🏠 Open wiki ]` in the Dashboard hero, and `← Back to wiki` at the bottom of the left sidebar.
- **User Impact:**
  - Administrators lose all sidebar orientation across 21 configuration views, and `Dashboard` falsely appears selected on every route.
- **Specific Corrections:**
  1. In [`client/components/admin.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin.vue), watch `$route.path` on mount and navigation to automatically expand the accordion group containing the active route, apply the warm active pill style (`background: var(--wiki-accent-subtle); color: var(--wiki-ink-primary); font-weight: 600`) to the active sub-item, and remove the static border box from `Dashboard` when `$route.path !== '/a'`.
  2. Replace the off-center unlabeled `[ ⇥ ]` icon button in the Admin top header with a clean labeled ghost pill (`← Wiki`) or rely on the persistent sidebar `← Back to wiki` link.
- **Final Acceptance Criteria:**
  - Navigating to any `/a/*` route automatically expands its parent sidebar group and highlights the active item, while `Dashboard` is only highlighted when on `/a`.

---

#### `ADMIN-02` (P0) — "Editorial Slogan Inflation": Double Display-Serif Heroes Consuming 35–45% of Desktop Admin Viewports & 100% of Mobile `/a/pages`

- **Components:**
  - [`client/components/common/admin-hero.vue`](file:///home/bbferko/repos/tsEpistle/client/components/common/admin-hero.vue)
  - [`client/components/admin/admin-pages.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-pages.vue)
  - [`client/components/admin/admin-pages-recycle-bin.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-pages-recycle-bin.vue)
  - [`client/components/admin/admin-pages-visualize.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-pages-visualize.vue)
  - [`client/components/admin/admin-tags.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-tags.vue)
  - [`client/components/admin/admin-theme.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-theme.vue)
  - [`client/components/admin/admin-analytics.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-analytics.vue)
  - [`client/components/admin/admin-storage.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-storage.vue)
  - [`client/components/admin/admin-system.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-system.vue)
  - [`client/components/admin/admin-dev-flags.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-dev-flags.vue)
- **Observed Problems:**
  - Across Admin routes, a top page header card (`admin-hero.vue`) is immediately followed by a **second giant `36px–42px` Newsreader display-serif marketing slogan banner** before any operational controls appear:
    - `/a/pages` (`63-admin-pages.png`): `Pages` header (`120px`) + *"A clear view of every page."* hero (`210px`) + filter bar (`140px`). Only **1.5 rows** of the pages table fit on a `1440×900` desktop screen! On Mobile (`390×844`, `92-mobile-admin-pages.png`), **0 page rows and 0 search inputs fit above the fold**—100% of the mobile viewport is consumed by headers and stat cards!
    - `/a/pages/recycle-bin` (`64-admin-recycle-bin.png`): `Page recovery` + *"A careful return, not an undo."*
    - `/a/pages/visualize` (`66-admin-visualize.png`): `Page atlas` + *"Follow the shape of your knowledge."* + *"How the wiki connects"*
    - `/a/tags` (`67-admin-tags.png`): `Tags` + *"Keep your shared vocabulary clean."*
    - `/a/theme` (`69-admin-theme.png`): `Theme` + *"Shape the reading room."*
    - `/a/analytics` (`72-admin-analytics.png`): `Analytics` + *"Measure visits with the providers you trust"*
    - `/a/storage` (`76-admin-storage.png`): `Storage` + *"Your knowledge, beyond this database"*
    - `/a/system` (`78-admin-system.png`): `System` + *"Runtime health & environment profile"*
    - `/a/dev-flags` (`81-admin-dev-flags.png`): `Developer flags` + *"Turn detail on only long enough to find the fault."*
- **User Impact:**
  - High-frequency administrative tools (page management, storage targets, diagnostics, recycle bin) require scrolling past `350px–480px` of repetitive poetic slogans on every single visit.
- **Specific Corrections:**
  1. **Remove the secondary display-serif slogan hero band** from all Admin operational views (`admin-pages.vue`, `admin-pages-recycle-bin.vue`, `admin-pages-visualize.vue`, `admin-tags.vue`, `admin-theme.vue`, `admin-analytics.vue`, `admin-storage.vue`, `admin-system.vue`, `admin-dev-flags.vue`).
  2. Consolidate each Admin route's header into a single compact `admin-hero.vue` strip (`max-height: 96px` on desktop) that pairs the route title + 1-line operational subtitle on the left with compact inline KPI pills (`32 pages · 1 draft · 1 private`) and primary actions on the right.
  3. Ensure data tables and primary filter bars begin by `y <= 190px` on desktop (`1440×900`), showing at least `8–10` table rows above the fold on `/a/pages`.
- **Final Acceptance Criteria:**
  - Every Admin view has a single concise header (`<= 96px` desktop height), zero duplicate poetic slogan banners exist, desktop `/a/pages` displays at least `8` page rows above the fold, and mobile `/a/pages` displays the search/filter bar and first page row above the fold.

---

#### `ADMIN-03` (P0) — Sticky `.admin-draft-bar` Occluding `Dictionary Language` Select on `/a/search` & Inconsistent Admin Save Patterns

- **Components:**
  - [`client/components/admin/admin-workspace.scss`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-workspace.scss#L2-L19)
  - [`client/components/admin/admin-search.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-search.vue)
- **Observed Problems:**
  - On `/a/search` (`1440×900`, `75-admin-search.png`), the sticky bottom `.admin-draft-bar` (`Configuration matches the last load | [ Reset changes ] [ Save configuration ]`) is rendered even when the form is completely clean (`!isDirty`), and **floats directly on top of the `Dictionary Language` select field**. The select field's floating label (`Dictionary Language`) pokes out above the bar while its helper text (`Select the language to use...`) pokes out below the bar, completely hiding the input box itself!
  - Across Admin routes, save mechanics are split arbitrarily: `/a/general`, `/a/navigation`, `/a/theme`, `/a/security`, and `/a/storage` use a top-right `[ ✓ Review changes ]` button in the hero, whereas `/a/search` and `/a/analytics` use the bottom `.admin-draft-bar` (`Save configuration`).
- **User Impact:**
  - Administrators on `/a/search` cannot see or click the `Dictionary Language` setting without scrolling past the sticky bar, and encounter two different save paradigms across sibling settings pages.
- **Specific Corrections:**
  1. In [`client/components/admin/admin-workspace.scss`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-workspace.scss#L2-L19), add `padding-block-end: 6.5rem` to `.admin-workspace` whenever `.admin-draft-bar` is present so sticky bottom bars can never overlap the last form control in the viewport.
  2. Only reveal `.admin-draft-bar` (via smooth slide-up transition) when `isDirty === true` (or keep all Admin settings pages unified on the top-right `[ Review changes ]` + dirty-only bottom bar pattern).
- **Final Acceptance Criteria:**
  - On `/a/search` at `1440×900`, `Dictionary Language` is 100% visible and interactive without occlusion, and `.admin-draft-bar` only appears when unsaved changes exist (or sits below reserved scroll padding).

---

#### `ADMIN-04` (P1) — `Page atlas` (`/a/pages/visualize`) SVG Node Label Pile-Up & Clipped Root Tree

- **Components:**
  - [`client/components/admin/admin-pages-visualize.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-pages-visualize.vue)
- **Observed Problems:**
  - On `/a/pages/visualize` (`1440×900`, `66-admin-visualize.png`), the `Folder tree` SVG visualization renders leaf labels (`Aglio e Olio`, `Best Mashed Potatoes`, `Blueberry Pancakes`, `Braised Short Ribs`, `Classic Beef Chili`, `Creamy Coleslaw`, `Crispy Brussels Sprouts`, `Dry Brine Turkey`, `Everyday Caesar Salad`, `Extra Crispy Potatoes`) at `~11px` vertical intervals so the text ascenders and descenders collide into a dense, barely legible stack, while the left-hand root/folder nodes of the tree are clipped off the bottom edge of the SVG viewport.
- **User Impact:**
  - The visual knowledge graph cannot be read or inspected without labels colliding or clipping off-canvas.
- **Specific Corrections:**
  1. In [`client/components/admin/admin-pages-visualize.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-pages-visualize.vue), increase minimum vertical leaf separation in the D3/SVG tree layout to `>= 22px` per node and dynamically compute the SVG `viewBox` / initial pan-zoom transform from `getBBox()` with `32px` padding on mount and on `[ Reset view ]`.
  2. Add compact floating canvas zoom controls (`[ + ]`, `[ − ]`, `[ Fit ]`) in the bottom-right corner of the diagram well.
- **Final Acceptance Criteria:**
  - All node labels in `Page atlas` have `>= 6px` clear vertical separation between lines, and the full tree fits within the initial SVG viewport without clipping root or leaf nodes.

---

#### `ADMIN-05` (P2) — Localized Layout, Truncation & Theme Sync Defects Across `General`, `Navigation`, `Theme`, `Agents`, `Utilities` & Mobile `Dashboard`

- **Components:**
  - [`client/components/admin/admin-general.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-general.vue)
  - [`client/components/admin/admin-navigation.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-navigation.vue)
  - [`client/components/admin/admin-theme.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-theme.vue)
  - [`client/components/agents/agent-admin.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-admin.vue)
  - [`client/components/admin/admin-utilities.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-utilities.vue)
  - [`client/components/admin/admin-dashboard.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-dashboard.vue)
- **Observed Problems:**
  1. **`/a/general` (`61-admin-general.png`, `61-admin-general-scrolled.png`):** Right-rail `AT A GLANCE` clips the site URL mid-character (`https://agents8c48g.tail41a24a.t`); `ACTIVE LOGO` scales a small raster icon to a blurry `2.5×` box; and `Ready to review a new workspace logo.` renders in heavy bold text even when no logo file has been selected.
  2. **`/a/navigation` (`62-admin-navigation.png`):** Splits `1160px` into 3 cramped columns where `Menu items` (`A starting point`) and `Selected item` (`Choose an item`) show two side-by-side empty states while `Main menu` wraps onto two lines in the header pill.
  3. **`/a/theme` in Dark Mode (`87-dark-admin-theme.png`):** Opening `/a/theme` while the application is in Dark Mode still defaults both the `Color tokens` editor (`Editing: Light`) and `LIVE SPECIMEN` (`Previewing: Light`) to Light Mode.
  4. **`/a/agents` (`74-admin-agents.png`, `74b-admin-agents-models.png`):** 11 top pill tabs wrap onto 2 uneven rows; clicking a tab scrolls the window down so the tab bar itself disappears off the top of the viewport (`74b-admin-agents-models.png`); and inside `Models & providers`, `UTILITY MODEL` wraps onto 2 lines inside narrow provider cards of unequal heights.
  5. **`/a/utilities` (`79-admin-utilities.png`):** Left sub-navigation truncates `Authentication cleanup` to `Authentication clean...`.
  6. **Mobile `/a` Dashboard (`91-mobile-admin.png`):** Fixed height/overflow on the 2-column stat cards (`Assets`, `Comments`) clips the bottom line of their subtitle descriptions.
- **User Impact:**
  - Truncated URLs/labels, blurry logo previews, desynchronized Dark Mode theme previews, and self-scrolling tab bars create friction across administrative workflows.
- **Specific Corrections:**
  1. [`admin-general.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-general.vue): Apply `overflow-wrap: anywhere; font-family: var(--wiki-font-mono); font-size: 0.8125rem` to the `Site URL` value; constrain the `ACTIVE LOGO` preview image with `max-width: 96px; max-height: 96px; object-fit: contain; image-rendering: auto`; and use regular muted body weight for `Select an image file to preview a new workspace logo.`
  2. [`admin-navigation.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-navigation.vue): Collapse the right-hand `Selected item` inspector into the `Menu items` card until an item is actually added or selected.
  3. [`admin-theme.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-theme.vue): Initialize both the token editor mode and `LIVE SPECIMEN` preview mode from the currently active application theme (`light` vs. `dark`).
  4. [`agent-admin.vue`](file:///home/bbferko/repos/tsEpistle/client/components/agents/agent-admin.vue): Group the 11 tabs into a sticky single-row segmented bar (or left sub-nav) that does not scroll itself out of view on tab selection, and use `grid-auto-rows: 1fr` with `white-space: nowrap` badge pills on the provider cards.
  5. [`admin-utilities.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-utilities.vue): Allow 2-line wrapping or widen the left sub-nav to `240px` so `Authentication cleanup` never truncates.
  6. [`admin-dashboard.vue`](file:///home/bbferko/repos/tsEpistle/client/components/admin/admin-dashboard.vue): Set `height: auto; min-height: 112px` on `.stat-card` on mobile viewports so subtitle lines never clip.
- **Final Acceptance Criteria:**
  - Site URLs and utility nav labels display without mid-word truncation; `/a/theme` initializes its specimen in the active color mode; `/a/agents` tabs remain visible when clicked; and mobile Dashboard stat cards never clip subtitle copy.

---

## 5. Architectural Strengths to Preserve

Implementation agents must **preserve** the following high-craft foundations already present in `tsEpistle`:
1. **Warm Archival Palette & Typography Pairing:** The light-mode warm linen/vellum palette (`#F9F6EE` / `#FFFDF9` / `#171512`) and Newsreader + Plus Jakarta Sans + JetBrains Mono triad in [`client/scss/base/base.scss`](file:///home/bbferko/repos/tsEpistle/client/scss/base/base.scss) give `tsEpistle` a distinctive editorial personality.
2. **Inline Source-Grounded Agent Architecture:** Keeping the `Wiki Agent` and `SOURCE NOTEBOOK` tightly bound to the current page context (`Sources X/8`, inline citations, and split-pane source preview) is a major product differentiator once the duplicate context bars (`AGENT-01`) and scroll/overlay bugs (`AGENT-02`, `AGENT-03`) are resolved.
3. **Comprehensive Admin & Governance Surface:** The breadth of enterprise controls (`/a/pages/integrity`, `/a/agents`, `/a/security`, `/a/dev-flags`, `/p/offline`) is remarkably complete; compacting the double hero banners (`ADMIN-02`) and fixing sidebar active state (`ADMIN-01`) will immediately unlock their utility.

---

## 6. Inspection Provenance, Distinguishing Observations vs. Assumptions & Inspection Gaps

- **Observed & Verified Directly (Zero Assumptions):**
  - All 29 findings (`SYS-01` through `ADMIN-05`) were directly observed in the live authenticated application across Light Mode (`1440×900`), Dark Mode (`1440×900`), Tablet (`768×1024`), and Mobile (`390×844`) using Playwright browser rendering, accessibility tree snapshots, console telemetry, and exact Vue/SCSS source verification.
- **Explicit Inspection Gaps & Non-Destructive Boundaries:**
  1. **Destructive Mutations Omitted by Contract:** In accordance with the read-only assessment constraint, destructive operations—such as permanently purging items in `/a/pages/recycle-bin`, revoking live MCP keys in `/p/profile`, executing authentication cleanup jobs in `/a/utilities`, or modifying live theme tokens in `/a/theme`—were inspected up to their confirmation/form surfaces without committing destructive writes.
  2. **Populated State for Empty Personal Tabs (`/p/notes`, `/p/discussions`, `/a/webhooks`):** The target environment currently contains `0` personal notes, `0` user comments, and `0` configured webhooks; findings on those surfaces cover their live empty-state rendering and layout containers rather than multi-hundred-row populated pagination.
  3. **External OAuth / SSO Redirect Flows:** Only the active local credential and forgot-password flows on `/login` and `/a/auth` configuration cards were exercised; third-party IdP redirect screens external to `tsEpistle` were outside scope.
