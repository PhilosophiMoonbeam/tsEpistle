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

## Code review process

The bigger the pull request, the longer it will take to review and merge. Try to break down large pull requests in smaller chunks that are easier to review and merge.
It is also always helpful to have some context for your pull request. What was the purpose? Why does it matter to you?

## Enterprise Release — security review and attestation workflow
This workflow applies only when a maintainer explicitly activates **Enterprise Release** for a named official beta, production release, or compliance milestone as defined in `AGENTS.md`. Development Sprint is the default: routine development and maintained local-tailnet deployment do not require an immutable source/attestation pair, review record, evidence document, manifest update, release tag, provenance record, or certification artifact.


tsEpistle gates release qualification through an executable, manifest-driven integrity gate (`bun run threat-model:check` and `bun server/scripts/check-threat-model.ts --release`). Historical release models relied on a monolithic markdown table row (`Covered source`) inside the threat model; current records are cataloged in `docs/security/review-attestations.json`.

The governing record and manifest format is `schemaVersion: 2`. Release authority is maintainer-owned: a maintainer or delegated agent performs and records the source review, and the reviewer's identity is attribution rather than a separate trust root. The former schemaVersion 1 external-review, detached-signature, and trusted-key process is superseded historical policy, not a current release prerequisite. Historical records are migrated for representation only, remain `releaseEligible: false`, and preserve their original findings and evidence.
The static prerequisite remains executable for hosted release-oriented automation: `package.json` defines `ci:static` with the exact unconditional `bun audit --production` segment after dependency and license checks and before broader gates, followed by `bun run threat-model:check`. Both the pull-request `pr-quality` job and the shared `quality` job invoke `bun run ci:static`; do not replace the audit with an echo, add `--ignore`/`--audit-level` variants, background it, or suppress it with `|| true`. A failed hosted check must be fixed rather than hidden. This existing automation is not the local Development Sprint acceptance command; Sprint uses the changed-path checks defined in `AGENTS.md`. The checker also parses and hashes a successfully read zero-byte threat model, so an empty model cannot pass by sentinel omission.


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
   - **Ordinary gate (`bun run threat-model:check`):** Verifies schema and manifest structure, checks that `threatModelDigest` matches `docs/security/threat-model.md`, confirms source and base commits exist with valid ancestry, matches `coveredTreeDigest` against the reviewed source and current tree, validates contained evidence, and reports staged, unstaged, untracked, ignored, index, or submodule boundary drift (with only the canonical `server/.build-metadata.json` exception above).
   - **Release gate (`bun server/scripts/check-threat-model.ts --release`):** Adds strict clean-tree requirements for all tracked and untracked paths, requires the active record to be a release-eligible schema-2 `source-review`, requires exact reviewed-source/current-`HEAD` boundary digest equality and the current model digest, and requires zero active blocking findings. Historical release-ineligible records and their historical findings remain parseable but do not authorize or block the active release.

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
