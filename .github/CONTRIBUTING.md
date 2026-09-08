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

Any code change should be submitted as a pull request. The description should explain what the code does and give steps to execute it. The pull request should also contain tests.

## Code review process

The bigger the pull request, the longer it will take to review and merge. Try to break down large pull requests in smaller chunks that are easier to review and merge.
It is also always helpful to have some context for your pull request. What was the purpose? Why does it matter to you?

## Security review and attestation workflow

tsEpistle gates release qualification through an executable, manifest-driven attestation gate (`bun run threat-model:check` and `bun server/scripts/check-threat-model.ts --release`). Historical release models relied on a monolithic markdown table row (`Covered source`) inside the threat model; this has been replaced by immutable, versioned review records cataloged in `docs/security/review-attestations.json`.

Release attestation requires an independent, release-eligible `source-review` record that certifies the exact Git commit of the codebase and includes a valid detached Ed25519 signature verified against an external trusted-key set. Every `source-review` record asserting `reviewer.independent: true` OR `releaseEligible: true`—whether active or historical—strictly requires a valid detached Ed25519 signature verified against an externally trusted key. In-repository booleans alone do not authorize release. Working-tree audits and content fingerprints (such as the staged search foundation audit) capture transient verification state during development, but they are strictly staged evidence (`releaseEligible: false`, `independent: false`), never releasable attestations.

### Canonical security boundary and digests

The canonical security boundary (policy version 1) includes:
- Source code roots: `server/`, `client/`, `shared/`, `deploy/`, `patches/`
- Developer and infrastructure tooling: the entire `dev/` prefix (including `dev/containers/`, `dev/helm/`, `dev/build/`, and all development tooling)
- CI/CD workflows and actions: `.github/workflows/`, `.github/actions/`
- Policy and configuration manifests: `package.json`, `bun.lock`, `bunfig.toml`, `biome.json`, `config.sample.yml`, `license-policy.json`, `playwright.config.ts`, `vite.config.mts`, and `tsconfig*.json`
- Root packaging, repository attribute, and legal compliance files: `.dockerignore`, `.gitattributes`, `LICENSE`, and `NOTICE`. Inclusion is essential for Docker and distribution archive integrity: `.dockerignore` establishes the container build context boundary (preventing unreviewed files or secrets from entering Docker images), `.gitattributes` governs release archive export filtering (`export-ignore`) and line endings for source distributions and release archives, and `LICENSE`/`NOTICE` establish mandatory licensing terms and attribution for container images and archives.
The gate computes a canonical `coveredTreeDigest` over every non-tree Git entry within this boundary (including files, executables, symlinks, and gitlinks/submodules) using the SHA-256 stream prefix `tsepistle-security-boundary-v1\0`, followed by entries sorted lexicographically by path formatted as `path\0mode\0type\0objectId\0`.

Documentation files (including `docs/`, `docs/security/review-attestations.json`, `docs/security/review-attestations/*.json`, and `docs/security/threat-model.md`) are intentionally excluded from the `coveredTreeDigest`. The threat model itself is validated separately by its 64-character lowercase SHA-256 content digest (`threatModelDigest`).

This deliberate boundary definition makes the attestation process strictly **non-circular**: reviewers can freeze and commit source changes, calculate canonical digests, produce an attestation document commit under `docs/security/`, and verify that the `coveredTreeDigest` remains completely unchanged between the reviewed commit and HEAD.

#### Generated build metadata exception

The security boundary checks fail closed on any uncommitted boundary changes, untracked boundary files, or ignored boundary files. The single allowed exception to ignored-boundary drift is the exact path `server/.build-metadata.json`:

- **Strict canonical requirements**: The exception is allowed only when `server/.build-metadata.json` is a non-symlink regular file, realpath-contained within the repository checkout, containing exact-object JSON with strings for `revision` and `date`, where `revision` equals the current Git `HEAD` commit SHA, and `date` is a valid canonical ISO 8601 UTC timestamp in exact JavaScript `Date.toISOString()` canonical form `YYYY-MM-DDTHH:mm:ss.sssZ` (matching the canonical output produced by `server/scripts/generate-build-metadata.ts` during `bun run build`).
- **Fail closed on malformed content or drift**: Any malformed JSON, extra or missing properties, non-regular file or symlink, mismatched revision (not matching `HEAD`), invalid date timestamp, or any other ignored file under `server/` or elsewhere within the canonical security boundary is treated as unauthorized boundary drift, fails dirty-state checks, and causes gate validation to fail closed.
- **Separate governance**: Because this file is gitignored to avoid repository pollution during local builds, it appears in `git status --ignored`. It is separately governed by build provenance and release artifact verification rather than working-tree source control.
- **Not a general server-prefix exemption**: This exception is strictly limited to the exact path `server/.build-metadata.json`. It does not create a wildcard, directory-level, or general `server/` prefix exemption. Any other ignored file under `server/` or elsewhere within the canonical security boundary is treated as unauthorized boundary drift and fails both ordinary and release gate checks.
- **Tracked content remains covered**: The path `server/.build-metadata.json` is not excluded from the security boundary definition (`isSecurityBoundaryPath`). If a file at `server/.build-metadata.json` is ever tracked in Git, it remains fully covered by the security boundary and is included in the canonical `coveredTreeDigest`.
### Step-by-step reviewer and release procedure

To perform a security review and advance a release candidate:

1. **Freeze and commit source:**
   Ensure all changes within the security boundary are committed to Git. Note the target commit SHA (`<revision>`). A release candidate cannot be certified from an uncommitted working tree.

2. **Calculate canonical digests:**
   Run the gate helper against the target revision to compute the covered-tree digest and threat-model digest:
   ```console
   bun server/scripts/check-threat-model.ts --digest <revision>
   ```
   This outputs:
   - `coveredTreeDigest`: The canonical SHA-256 digest of the security boundary tree at `<revision>`.
   - `threatModelDigest`: The SHA-256 content digest of `docs/security/threat-model.md`.

3. **Author an immutable structured review record:**
   Create a new review record file `docs/security/review-attestations/<id>.json` conforming to `schemaVersion: 1`:
   ```json
   {
     "schemaVersion": 1,
     "id": "<id>",
     "repository": "PhilosophiMoonbeam/tsEpistle",
     "kind": "source-review",
     "policyVersion": 1,
     "threatModelDigest": "<64-hex-sha256-of-threat-model>",
     "reviewer": {
       "identity": "Reviewer Name <reviewer@example.com>",
       "independent": true,
       "reviewedAt": "2026-09-08"
     },
     "releaseEligible": true,
     "source": {
       "revision": "<commit-sha>",
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
     ],
     "signature": {
       "algorithm": "ed25519",
       "keyId": "<key-id>",
       "value": "<detached-ed25519-signature>"
     }
   }
   ```
   - **Repository binding:** Every review record must declare `"repository": "PhilosophiMoonbeam/tsEpistle"`.
   - **Reviewer and timestamp:** The reviewer object defines `identity`, `independent` boolean, and `reviewedAt` in exact UTC calendar date format `YYYY-MM-DD` (e.g., `"2026-09-08"`). Timestamps containing time of day or fractional seconds are rejected by the schema.
   - **Independence & release eligibility assertions:** Setting `"independent": true` and `"releaseEligible": true` is a required schema assertion for official release candidates, but repository booleans alone never authorize release. Every `source-review` record declaring `"independent": true` OR `"releaseEligible": true`—whether active or a historical entry in the manifest—strictly requires a structurally valid detached Ed25519 signature verified against an externally trusted key in `THREAT_REVIEW_TRUSTED_KEYS_JSON`. An unsigned or unverified claim in any source-review record fails verification and blocks the gate. Maintainer self-reviews or internal baselines must specify `"independent": false` and `"releaseEligible": false`.
   - **Structured findings:** Findings must specify a disposition of `"resolved"`, `"accepted"` (with written justification in the cited evidence), or `"blocking"`. Any record containing an open `"blocking"` finding cannot be release-eligible.
   - **Immutability:** Once committed, review records must never be modified in-place; subsequent reviews or status changes require creating a new record.

4. **Detached Ed25519 signing procedure:**
   Every `source-review` record claiming `reviewer.independent: true` or `releaseEligible: true` (including non-active historical entries) requires a detached Ed25519 signature:
   - **Canonical payload:** Construct the payload by taking the entire record JSON object with the `"signature"` property omitted, encoding it into compact JSON with recursively key-sorted keys at every nesting level (no insignificant whitespace), and prepending the UTF-8 domain prefix `tsepistle-threat-review-attestation-v1\0`.
   - **Signature generation:** The reviewer signs the canonical payload bytes using their Ed25519 private key.
   - **Signature attachment:** Attach the detached signature object to the record:
     ```json
     "signature": {
       "algorithm": "ed25519",
       "keyId": "<key-id>",
       "value": "<ed25519-signature-hex-or-base64>"
     }
     ```

5. **External trusted-key set and signer identity binding:**
   To prevent repository self-authorization, trusted signing keys **must not be stored in this repository**.
   - In CI and publication workflows (including pull-request quality checks and beta/release publication gates), the threat checker receives trusted public keys via the external environment variable `THREAT_REVIEW_TRUSTED_KEYS_JSON`, populated from the GitHub public repository variable `vars.THREAT_REVIEW_TRUSTED_KEYS_JSON`. Because this repository variable contains only public verification keys rather than private signing keys, it is PR-safe and accessible across unprivileged pull-request static checks (`pr-quality`), branch quality checks (`quality`), and protected release gates (`beta`, `release`).
   - The external trusted-key JSON payload has the schema:
     ```json
     {
       "schemaVersion": 1,
       "repository": "PhilosophiMoonbeam/tsEpistle",
       "keys": [
         {
           "id": "<key-id>",
           "identity": "Reviewer Name <reviewer@example.com>",
           "algorithm": "ed25519",
           "publicKey": "<ed25519-public-key-hex-or-base64>"
         }
       ]
     }
     ```
   - **Signer identity binding:** The key ID specified in `record.signature.keyId` must exist in the trusted key set for `"repository": "PhilosophiMoonbeam/tsEpistle"`, and the trusted key's `identity` MUST strictly match `record.reviewer.identity`. The signature is verified against the trusted public key over the canonical payload.
   - If `THREAT_REVIEW_TRUSTED_KEYS_JSON` is missing, or the key is missing/untrusted, or the signer identity does not match, or the signature fails verification, the release gate strictly fails and blocks publication.

6. **Select the record in the manifest:**
   Update `docs/security/review-attestations.json`:
   - Set `"activeReviewId"` to `"<id>"`.
   - Append `{ "id": "<id>", "path": "docs/security/review-attestations/<id>.json" }` to the `"records"` array.

7. **Commit the attestation documentation:**
   Commit the new review record and updated manifest in `docs/security/`. Because documentation is excluded from the security boundary, this commit leaves the `coveredTreeDigest` unchanged. If any file inside the security boundary was modified, the covered digest will change and the release gate will fail.

8. **Execute gate validation:**
   - **Ordinary gate (`bun run threat-model:check`):**
     Verifies manifest structure, checks that `threatModelDigest` matches `docs/security/threat-model.md`, confirms the Git commit exists and is reachable, matches `coveredTreeDigest` against the current tree, and reports any staged, unstaged, untracked, or ignored boundary drift (with the sole canonical exception of the non-symlink regular file `server/.build-metadata.json` matching current HEAD and valid ISO timestamp).
   - **Release gate (`bun server/scripts/check-threat-model.ts --release`):**
     Strict enforcement for release candidates. Fails if the working tree has any uncommitted or untracked boundary changes, or ignored boundary files (with the sole canonical exception of a non-symlink regular file `server/.build-metadata.json` containing exact canonical JSON whose `revision` matches HEAD and whose `date` is a valid ISO timestamp in exact JavaScript `Date.toISOString()` canonical form `YYYY-MM-DDTHH:mm:ss.sssZ`; any malformed JSON, symlink, or revision mismatch fails closed), requires an exact match between the active record's `coveredTreeDigest` and HEAD, ensures zero blocking findings, checks in-record schema assertions, and verifies the Ed25519 signature against `THREAT_REVIEW_TRUSTED_KEYS_JSON` for all independent or release-eligible source reviews, strictly enforcing signer identity binding. Repository booleans alone never authorize release.
### Staged working-tree evidence vs. releasable source reviews

During development, specialized audits may evaluate uncommitted working-tree changes (such as the search foundation audit). These use `kind: "working-tree-audit"` and record `source: { baseRevision, fingerprint, fingerprintAlgorithm }`.
- **Staged-audit restrictions:** Working-tree audits capture transient verification state during development. They must have `reviewer.independent: false`, `releaseEligible: false`, no signature (`signature` omitted), and `source.fingerprintAlgorithm` set exactly to `"tsepistle-isolated-preview-v1"`.
- Working-tree audits are **strictly release-ineligible** and cannot be used as release attestations or authorize deployment.
- Releasing any feature or refactor requires committing the source code within the canonical security boundary, calculating canonical digests, completing a formal `source-review`, and signing the record with an external trusted Ed25519 key.
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
