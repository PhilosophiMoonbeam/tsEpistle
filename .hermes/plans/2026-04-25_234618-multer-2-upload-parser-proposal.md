# Multer 2 Upload Parser Modernization Proposal

> **For Hermes:** This is an approval-gated modernization proposal, not authorization to upgrade `multer` yet. Do not execute the dependency bump until the user explicitly approves this campaign.

**Goal:** Modernize the upload parser from `multer@1.4.4` to `multer@2.1.1` while preserving the current Wiki.js upload behavior, authorization semantics, temp-file handling, and stable test/build baseline.

**Architecture:** Keep the current Express 4 upload route and business handler. Treat Multer as a parser dependency behind the existing `/u` controller contract, add real multipart characterization coverage before the bump, then perform the smallest package-only update unless tests prove explicit error mapping is required.

**Tech Stack:** Node >=20, Express 4, Multer disk storage, current `server/controllers/upload.js`, Jest 27, existing Vue 2 / Webpack 4 / GraphQL baseline unchanged.

---

## Executive decision requested

Approve or reject a focused `multer` campaign with these boundaries:

- Target: `multer` `1.4.4` -> `2.1.1`.
- Preserve: Express 4, JWT/session/auth semantics, upload route shape, asset permission checks, file metadata passed to `WIKI.models.assets.upload`.
- Do not bundle: Express 5, body-parser 2, auth/session rewrites, upload UX redesign, storage-model rewrites, organization-specific upload features.
- First implementation attempt should be package-only plus tests; production upload code changes are allowed only if real parser tests reveal a compatibility or user-visible error-shape regression.

Recommended decision: approve the campaign only with the staged gates below.

---

## Current baseline

Current production route: `server/controllers/upload.js`

```js
router.post('/u', (req, res, next) => {
  multer({
    dest: path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'uploads'),
    limits: {
      fileSize: WIKI.config.uploads.maxFileSize,
      files: WIKI.config.uploads.maxFiles
    }
  }).array('mediaUpload')(req, res, next)
}, async (req, res, next) => {
  // business validation and WIKI.models.assets.upload(...)
})
```

Existing regression coverage: `server/test/controllers/upload.test.js`

It already pins:

- POST `/u` route registration.
- GET `/u` health response.
- Multer `dest`, `limits`, and `array('mediaUpload')` wiring.
- Coarse upload permission rejection before business processing.
- Empty upload payload rejection.
- Multiple file rejection after parser success.
- Missing / malformed `mediaUpload` JSON rejection.
- `folderId: 0` normalization to `null`.
- Filename lowercasing and whitespace/comma/semicolon/hash replacement.
- Folder hierarchy-derived asset paths.
- Folder lookup failure handling.
- Path-level `WIKI.auth.checkAccess` rejection.
- Successful `WIKI.models.assets.upload` payload shape.

This test file mocks Multer by design. It is necessary but not sufficient for a parser major upgrade.

---

## Package compatibility evidence

Current package:

```text
multer@1.4.4
engines: { node: '>= 0.10.0' }
dependencies:
  append-field: ^1.0.0
  busboy: ^0.2.11
  concat-stream: ^1.5.2
  mkdirp: ^0.5.4
  object-assign: ^4.1.1
  on-finished: ^2.3.0
  type-is: ^1.6.4
  xtend: ^4.0.0
```

Proposed package:

```text
multer@2.1.1
engines: { node: '>= 10.16.0' }
dependencies:
  append-field: ^1.0.0
  busboy: ^1.6.0
  concat-stream: ^2.0.0
  type-is: ^1.6.18
```

Important compatibility findings from subagent audit:

- `require('multer')` remains CommonJS-compatible.
- `multer({ dest, limits }).array('mediaUpload')` still exists.
- `dest` still writes uploaded files to disk with generated names.
- Disk file metadata remains compatible for the controller's needs:
  - `originalname`
  - `encoding`
  - `mimetype`
  - `destination`
  - `filename`
  - `path`
  - `size`
- `dest` string still creates the destination directory automatically.
  - `multer@1.4.4`: `mkdirp.sync(destination)`
  - `multer@2.1.1`: `fs.mkdirSync(destination, { recursive: true })`
- `multer.MulterError` still exists.
- `limits.fileSize` still produces `LIMIT_FILE_SIZE`.
- `limits.files` still produces `LIMIT_FILE_COUNT`.
- Isolated `multer@2.1.1` runtime check confirmed a multipart request can include both:
  - a text field named `mediaUpload` containing metadata JSON
  - a file field named `mediaUpload`
  and still populate `req.body.mediaUpload` plus `req.files` as expected.

---

## Primary risks

### 1. Real parser behavior is not covered by current tests

The existing tests mock Multer. They verify route/business logic, but not actual multipart parsing, disk writes, limit errors, field/file ordering, or temp-file cleanup.

Mitigation: add real-Multer integration characterization tests before the dependency bump.

### 2. Busboy major upgrade

`multer@2.1.1` moves from the old Busboy line to `busboy@^1.6.0`. Multer adapts the busboy API internally, but multipart edge cases can still shift:

- text/file part ordering
- field and file with the same name
- filename decoding
- malformed multipart handling
- truncated/over-limit request behavior
- close/finish timing

Mitigation: keep tests narrow and focused on the controller contract that Wiki.js actually depends on.

### 3. Error response shape for MulterError

The current controller calls Multer middleware and delegates parser errors to `next(err)`. It does not map `MulterError` to the JSON response shape used by the business-handler validation branches.

Potential outcomes:

- If current/global Express error behavior is acceptable, do not change production code; only assert that `MulterError` reaches error middleware with the expected code.
- If stable JSON upload errors are desired, explicitly implement mapping for known `MulterError` codes in the route wrapper. This is a behavior change and should be separately reviewed.

### 4. Parser-level vs controller-level multiple-file behavior

The controller currently rejects `req.files.length > 1` with:

```text
You cannot upload multiple files within the same request.
```

But if `WIKI.config.uploads.maxFiles === 1`, Multer may emit `LIMIT_FILE_COUNT` before the business handler runs.

Mitigation:

- Preserve current config wiring.
- Test controller-level multiple-file rejection with `maxFiles > 1`.
- Separately test limit behavior with `maxFiles === 1` and decide whether generic or mapped error behavior is acceptable.

### 5. Filename decoding and non-ASCII filenames

`multer@2.1.1` / `busboy@1.6.0` can differ in filename decoding details. The controller lowercases and sanitizes `fileMeta.originalname` before authorization and upload.

Mitigation: include a non-ASCII filename smoke test and treat any changed sanitized path as approval-gated behavior drift.

---

## Proposed implementation gates

### Gate 0: Pre-bump characterization coverage

**Objective:** Prove current upload behavior through real Multer, not only mocked route tests.

**Files:**

- Create: `server/test/controllers/upload.integration.test.js`
- Keep: `server/test/controllers/upload.test.js`
- Do not modify production code in this gate.

**Test environment:**

Use Node environment for real HTTP/multipart tests:

```js
/**
 * @jest-environment node
 */
```

**Avoid new dependencies initially:**

Do not add `supertest`, `form-data`, or `undici` unless a later review explicitly approves a test helper dependency. Although Node >=20 exposes `fetch`, `FormData`, and `Blob` in the normal Node runtime, this repo's Jest 27 `node` test environment does not reliably expose those globals inside the test VM. Prefer manual multipart requests with `node:http` and `Buffer` boundaries for Gate 0. If a helper dependency or test-environment shim is proposed instead, document it separately and account for ESLint `no-undef`.

**Integration app setup:**

The test app must mount a small auth stub before the upload router because `server/controllers/upload.js` assumes `req.user` exists. Default stub:

```js
app.use((req, res, next) => {
  req.user = {
    id: 7,
    permissions: ['write:assets']
  }
  next()
})
```

Override this per test only when intentionally exercising auth rejection behavior.

**Temp-file safety:**

Each test must:

1. Create a unique temp root:

```js
await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wiki-upload-test-'))
```

2. Set:

```js
WIKI.ROOTPATH = tempRoot
WIKI.config.dataPath = 'data'
```

3. Use upload destination:

```js
path.join(tempRoot, 'data', 'uploads')
```

4. Close the ephemeral HTTP server in `afterEach` / `finally`; promisify or await `server.close()` to avoid open Jest handles.
5. Remove the temp root in `afterEach` / `finally`:

```js
await fs.promises.rm(tempRoot, { recursive: true, force: true })
```

This cleanup requirement is for the integration test harness. Do not treat current production per-request temp-file retention after business-validation failures as a bug in this campaign unless a separate behavior-change proposal explicitly adds upload temp-file cleanup semantics.

**Required characterization tests:**

1. Successful single upload:
   - multipart text field `mediaUpload = JSON.stringify({ folderId: 0 })`
   - multipart file field `mediaUpload` containing a manually encoded file part
   - expect `200` / `ok`
   - expect `WIKI.models.assets.upload` called once
   - assert upload payload includes:
     - `mode: 'upload'`
     - `folderId: null`
     - sanitized `originalname`
     - matching `assetPath`
     - `path`, `destination`, `filename`, `size`
   - assert temp file exists at time `assets.upload` mock is called

2. Missing file:
   - metadata field present, no file
   - expect current `400` response:
     - `Missing upload payload.`

3. Missing metadata:
   - file present, no metadata field
   - expect current `400` response:
     - `Missing upload folder metadata.`

4. Multiple files with parser limit high enough:
   - set `WIKI.config.uploads.maxFiles = 3`
   - send two file parts named `mediaUpload`
   - expect current controller business response:
     - `You cannot upload multiple files within the same request.`

5. Limit behavior characterization:
   - set tiny `maxFileSize`
   - send larger file
   - test-only error middleware should capture `err.code === 'LIMIT_FILE_SIZE'`
   - do not require a public JSON mapping unless this campaign explicitly includes it

6. Non-ASCII filename smoke:
   - filename like `Résumé 2026.PNG`
   - assert current sanitized result on the active parser before the bump
   - after bump, compare; stop if it changes unexpectedly

**Gate 0 verification commands:**

```bash
corepack yarn jest server/test/controllers/upload.test.js server/test/controllers/upload.integration.test.js --runInBand
corepack yarn test
corepack yarn build
```

**Commit boundary:**

If Gate 0 is implemented separately, commit it as:

```bash
git add server/test/controllers/upload.integration.test.js
git commit -m "[verified] test: characterize real upload parser behavior"
```

---

### Gate 1: Package-only Multer update

**Objective:** Update Multer with no production code changes unless tests force otherwise.

**Files:**

- Modify: `package.json`
- Modify: `yarn.lock`
- Prefer no production code modifications.

**Command:**

```bash
corepack yarn add --exact multer@2.1.1 --non-interactive
```

**Expected lockfile changes:**

- `multer@2.1.1`
- direct Multer dependency closure should include:
  - `append-field@^1.0.0`
  - `busboy@^1.6.0`
  - `concat-stream@^2.0.0`
  - `type-is@^1.6.18`
- direct Multer dependency closure should drop:
  - `mkdirp`
  - `object-assign`
  - `on-finished`
  - `xtend`
- Some removed packages may remain in `yarn.lock` if other dependency paths still require them.

**Gate 1 verification:**

```bash
node -p "require('multer/package.json').version"
node -p "JSON.stringify(require('multer/package.json').dependencies, null, 2)"
corepack yarn why multer
corepack yarn list --pattern 'multer|busboy|append-field|concat-stream|type-is' --depth=1
corepack yarn check --integrity
git diff --check
corepack yarn jest server/test/controllers/upload.test.js server/test/controllers/upload.integration.test.js --runInBand
corepack yarn test
corepack yarn build
```

**Static/security review:**

- Scan added diff lines for credentials/secrets.
- Review package and lockfile scope.
- Confirm Vue/Webpack/Auth/GraphQL/DB protected versions remain unchanged.

**Independent review:**

Use two subagent reviews:

1. Spec/security review:
   - no production auth drift
   - no broad dependency churn
   - upload behavior preserved
   - no secrets

2. Code-quality/integration review:
   - tests meaningful and not brittle
   - temp files safely cleaned
   - parser edge cases covered
   - no accidental Express/body-parser/session changes

**Commit boundary:**

```bash
git add package.json yarn.lock server/test/controllers/upload.integration.test.js
git commit -m "[verified] chore: refresh upload parser dependency"
```

If Gate 0 was committed separately, Gate 1 should commit only `package.json` and `yarn.lock` unless production compatibility fixes were necessary.

---

### Gate 2: Optional explicit MulterError mapping

**Only execute Gate 2 if approved or if Gate 1 tests reveal unacceptable user-visible behavior.**

**Objective:** Convert known parser errors into stable JSON upload responses.

**Potential production change:**

Modify only the first `/u` middleware wrapper in `server/controllers/upload.js`:

```js
router.post('/u', (req, res, next) => {
  multer({
    dest: path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'uploads'),
    limits: {
      fileSize: WIKI.config.uploads.maxFileSize,
      files: WIKI.config.uploads.maxFiles
    }
  }).array('mediaUpload')(req, res, err => {
    if (!err) {
      return next()
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        succeeded: false,
        message: 'Upload request is invalid.'
      })
    }
    next(err)
  })
}, async (req, res, next) => {
  // existing business handler
})
```

The exact status and messages require product approval before implementation. For example, `LIMIT_FILE_SIZE` could be `413` instead of `400` if the project wants semantically precise HTTP status codes.

**Do not include this by default.** It is safer to keep behavior unchanged unless stable JSON parser errors are explicitly desired.

---

## Stop conditions

Stop and ask for review/approval if any of these happen:

1. `server/controllers/upload.js` needs semantic changes beyond a tiny parser error wrapper.
2. Auth behavior changes:
   - `write:assets` / `manage:system` checks move or change
   - `WIKI.auth.checkAccess` path changes
   - uploads can reach `WIKI.models.assets.upload` without the same checks
3. File metadata consumed by `WIKI.models.assets.upload` changes or disappears:
   - `path`
   - `destination`
   - `filename`
   - `originalname`
   - `mimetype`
   - `size`
4. Real multipart test shows `req.body.mediaUpload` no longer populates reliably.
5. Multiple-file behavior changes unexpectedly.
6. Limit errors require product-visible response policy decisions.
7. Non-ASCII filename sanitization changes unexpectedly.
8. Lockfile churn includes Express, body-parser, session, auth, Vue, Webpack, Apollo/GraphQL, Knex, or Objection changes.
9. `corepack yarn test` or `corepack yarn build` fails outside known baseline warnings.
10. Temp upload files remain after integration test teardown cleanup, or a proposed implementation silently changes production per-request temp-file cleanup behavior without explicit review.

---

## Proposed approval text

If the user approves, proceed with:

1. Gate 0: add and verify real Multer integration characterization tests against the current `multer@1.4.4` baseline.
2. Gate 1: update to `multer@2.1.1` with no production code changes unless the characterization tests expose compatibility drift.
3. Gate 2 only if explicitly needed: propose exact `MulterError` JSON mapping before implementation.

Do not proceed with Express 5, body-parser 2, upload UX changes, or auth/session changes in this campaign.
