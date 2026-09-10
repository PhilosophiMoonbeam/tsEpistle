# Docker TypeScript-config successor evidence — 2026-09-10

## Review identity, ancestry, and binding

This document is immutable evidence for schema-2 source-review record
`security-review-dd783e3aad6d8ecc6800797ad76dcc63d2ed1156`.

- **Exact reviewed source range:** `871003fab75a1e2f55d5ec768d74e9643ead862e..dd783e3aad6d8ecc6800797ad76dcc63d2ed1156` (`S1..S2`).
- **S1 source freeze:** `871003fab75a1e2f55d5ec768d74e9643ead862e`.
- **Documentation-only ancestor (`A1`):** `a6b7803d05fd8190eb09fd0dbc6f9e504be2c2f0`, whose parent is S1 and whose S1..A1 delta is limited to `docs/security/review-attestations.json`, `docs/security/review-attestations/security-review-871003fab75a1e2f55d5ec768d74e9643ead862e.json`, `docs/security/security-review-871003fab75a1e2f55d5ec768d74e9643ead862e-evidence.md`, and `docs/security/threat-model.md`.
- **S2:** `dd783e3aad6d8ecc6800797ad76dcc63d2ed1156`, child of A1. The reviewed source correction A1..S2 changes exactly `dev/build/Dockerfile` and `dev/build-arm/Dockerfile`; no other source path changes.
- **Covered security-boundary digest:** `0b12f39dd17a1b4650365ec1909a02f1eb1c1fb2b2c852a1957e75a8e0ac0d41`.
- **Threat-model SHA-256:** `2b2baa8c523bbbb2b3ffa89e2cad954ba63e3af372529dc76e931291bbd3b748`; policy version and model version remain 1.
- **Documentation successor (`A2`):** this record and evidence are outside the covered source boundary. `source.baseRevision` is S1, not A1.

`DockerPackagingSecurityReview` supplied the delegated review at `agent://DockerPackagingSecurityReview` and performed a read-only static source and diff review of the Docker/configuration closure, reporting **PASS** with no new blocking or non-blocking finding. The reviewer ran no commands, builds, tests, formatters, validators, payloads, or network operations and made no edits. Main-executed observations below are separately attributed to Main.

## Exact Docker correction and security boundaries

The two-Dockerfile source change is:

- `dev/build/Dockerfile`: the build stage changes `COPY vite.config.mts ./` to `COPY vite.config.mts tsconfig.client.json tsconfig.server.json tsconfig.shared.json ./`; the runtime stage adds `COPY --chown=bun:bun tsconfig.server.json tsconfig.shared.json ./`.
- `dev/build-arm/Dockerfile`: the runtime stage adds `COPY --chown=bun:bun tsconfig.server.json tsconfig.shared.json ./`.

The AMD64 build therefore contains the authoritative client, server, and shared root configs needed by Vite and the client/server wrappers. Both runtime stages contain only the authoritative server/shared root configs needed by `server/index.ts`; neither runtime contains `tsconfig.client.json` or client source. `tsconfig.ts1.json` has no active build/runtime reference and remains absent. The existing wrapper references and config contents are unchanged.

The correction adds only named, tracked JSON copies. It adds no `COPY .`, wildcard, broader context selector, build secret, new `ARG`, or new mount; existing cache mounts and build arguments are unchanged. `.dockerignore` and `.gitignore` exclusions remain unchanged, including Git metadata, dependency trees, caches/test output, archives, `.env` files, logs, and deployment-owned secrets/state. The pinned Dockerfile frontend and base image, frozen-lockfile installs, production-only runtime dependencies, exact revision/date arguments, and OCI labels remain bounded. No secret or source-context boundary is widened.

## Main-executed build and packaging observations

- **A1 discovery (artifact `artifact://459:570-642`):** the pre-correction AMD64 Docker build reached Vite and failed closed with `Tsconfig not found /wiki/tsconfig.client.json`. It exited before producing or publishing a misleading image; this is discovery evidence for the missing config closure, not a finding.
- **S2 build (artifact `artifact://464`):** Main ran `bun run docker:build tsepistle:verify-dd783e3aad6d8ecc6800797ad76dcc63d2ed1156`. The build copied all three root configs, completed Vite (`3858 modules transformed`), passed every reported bundle-budget check, copied only server/shared root configs into the runtime stage, and exported the image tagged with the exact S2 revision.
- **OCI identity and runtime checks (Main command observations):** inspection printed `dd783e3aad6d8ecc6800797ad76dcc63d2ed1156 linux/amd64`, and runtime metadata printed the exact S2 revision. Source/architecture inspection printed `https://github.com/PhilosophiMoonbeam/tsEpistle amd64`, confirming the source label and AMD64 architecture. Runtime shell checks passed with server/shared root configs present and `tsconfig.client.json` and client source absent.
- **Linux bundle (Main command observation):** `create-linux-bundle.sh` completed successfully. The bundle members below matched checkout SHA-256 values:
  - `./tsconfig.server.json` — `2872e3fd62b1638ef1da3e60bab35a2d0f34d0b6df98ce993b152fa2b604205a`
  - `./tsconfig.shared.json` — `352b644d06cb15f8cbc9d05a29ca9100805229efa1c263d970771fa935e7fd1d`
  - `./server/tsconfig.json` — `9b2b217ea113ab518c7547b1ade23ac948278fc5466eeb89744066d4acb2a35a`
  - `./shared/tsconfig.json` — `5c491366e79d99ffb747a9abaa39e7202d7b0a14016d8c3856c04b3a50c51e5a`

These observations establish the retained S2 AMD64 build/bundle proof only. Native ARM64 execution remains a CI responsibility; this reviewer and the cited Main proof make no native ARM64 execution claim.

## Findings and disposition

All nine predecessor finding objects are carried into the S2 record byte-for-byte unchanged: `AUTH-APIKEY-HUMAN-IMPERSONATION` (High, resolved), `AUTH-CALLBACK-INITIATION-BINDING` (High, resolved), `AUTH-OAUTH-STATE-LIFECYCLE` (High, resolved), `STORAGE-ASSET-001` (High, resolved), `STORAGE-IMPORT-002` (High, resolved), `STORAGE-BACKUP-003` (High, resolved), `SEC-STORAGE-NATIVE-BOUND-001` (Medium, accepted), `SEC-ADAPTER-001` (Medium, accepted), and `SEC-CACHE-001` (Medium, resolved). The packaging-only delta introduces no path that reopens those authentication, storage, adapter, or cache root causes. No new finding was added.

## Explicit exclusions and non-claims

This evidence excludes deployment, live production behavior, registry publication or push, post-A2 strict cleanliness, strict attestation-gate/release proof, external-provider canaries, and native ARM64 execution. It does not claim an A2 build, A2 push, A2 deployment, or A2 strict gate pass. `releaseEligible: true` in the source-review record is the maintainer attestation for S2's reviewed source and zero-blocker finding state; it is not a claim that the documentation successor has passed the strict gate or been released.
