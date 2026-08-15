# Campaign 3: Server utility and parser stabilization plan

> For Hermes: execution only after explicit approval. Use subagent-driven-development if approved.

Goal: modernize server-side utility/parsing dependencies with moderate surface area while preserving current DB, rendering, and import/export behavior.

Architecture: keep Express 4, Apollo 2, Knex 0.21, and the current rendering/storage model intact. Upgrade only helper packages that influence parsing, file handling, and metadata extraction.

---

## Grounded code hotspots

Key files from current repo inspection:
- `server/models/pages.js`
  - imports `fs-extra`, `js-yaml`, `cheerio`, `striptags`, `emoji-regex`, `turndown`
  - central for page parsing / normalization / transformation
- `server/controllers/upload.js`
  - uses `sanitize-filename`
  - upload and metadata path
- `server/modules/rendering/html-security/renderer.js`
  - sanitization/rendering helper path
- `server/jobs/sanitize-svg.js`
  - DOM-based sanitization path
- import/export or migration helpers under `server/db/` and related file helpers

Candidate packages still remaining:
- `fs-extra` 9.0.1 -> 11.3.4
- `js-yaml` 3.14.0 -> 4.1.1
- `cheerio` 1.0.0-rc.5 -> 1.2.0
- `image-size` 0.9.2 -> 2.0.2
- `klaw` 3.0.0 -> 4.1.0
- `mime-types` 2.1.35 -> 3.0.2

---

## Recommended batch structure

### Batch 3A: metadata/file helpers
- `mime-types` 2.1.35 -> 3.0.2
- `image-size` 0.9.2 -> 2.0.2
- `klaw` 3.0.0 -> 4.1.0

### Batch 3B: filesystem helper update
- `fs-extra` 9.0.1 -> 11.3.4

### Batch 3C: parser/DOM helper update
- `js-yaml` 3.14.0 -> 4.1.1
- `cheerio` 1.0.0-rc.5 -> 1.2.0

Why grouped this way:
- 3A is lowest-risk metadata/file walking work
- 3B changes file helper semantics broadly and deserves isolation
- 3C is the riskiest because it can change parsing output

---

## Validation strategy

### Required automated gates
- `corepack yarn test`
- `corepack yarn build`

### Additional targeted checks
- page frontmatter parsing still behaves identically for representative samples
- upload metadata extraction still works
- import/export helpers still function on representative content
- HTML transform paths still preserve expected structure

### Test expansion recommended before 3C
If approved, add targeted regression tests around:
- markdown/html frontmatter extraction in `server/models/pages.js`
- representative cheerio transformations
- file metadata extraction helpers

---

## Batch 3A details

### Objective
Update low-level file metadata helpers without changing parser semantics.

### Files likely to matter
- `package.json`
- `yarn.lock`
- upload/helpers that infer file type or size
- import/export traversal helpers

### Commands
1. `corepack yarn add mime-types@3.0.2 image-size@2.0.2 klaw@4.1.0 --exact --non-interactive`
2. `corepack yarn test`
3. `corepack yarn build`

### Review focus
- file type inference behavior
- image metadata extraction compatibility
- file tree walking semantics

### Commit message
- `[verified] chore: stabilize server metadata helpers batch 3A`

---

## Batch 3B details

### Objective
Update `fs-extra` in isolation because it has broad file operation surface area.

### Files likely to matter
- `server/models/pages.js`
- any import/export/storage helpers using `fs-extra`
- `package.json`
- `yarn.lock`

### Commands
1. `corepack yarn add fs-extra@11.3.4 --exact --non-interactive`
2. `corepack yarn test`
3. `corepack yarn build`

### Review focus
- any changed semantics around copy/remove/path existence helpers
- sync vs async helper expectations

### Commit message
- `[verified] chore: stabilize filesystem helpers batch 3B`

---

## Batch 3C details

### Objective
Update parser/DOM helpers that may subtly change page content handling.

### Files likely to matter
- `server/models/pages.js`
- any HTML transform helper using `cheerio`
- YAML/frontmatter consuming code
- `package.json`
- `yarn.lock`

### Commands
1. `corepack yarn add js-yaml@4.1.1 cheerio@1.2.0 --exact --non-interactive`
2. `corepack yarn test`
3. `corepack yarn build`

### Required targeted checks
- parse representative markdown frontmatter blocks
- parse representative HTML content blocks
- compare cleaned/normalized output before vs after

### Review focus
- YAML duplicate-key or schema behavior changes
- Cheerio parsing differences on legacy HTML

### Commit message
- `[verified] chore: stabilize parser helpers batch 3C`

---

## Stop conditions
Stop and reassess if:
- frontmatter parsing differs for representative samples
- upload/import/export flows change behavior unexpectedly
- HTML transform output shifts in a way current tests do not cover
- helper API changes require broad code rewrites

## Suggested place in sequence
Run after Campaign 1, and either before or after Campaign 2 depending on whether upload/editor or server parser risk is a higher priority.