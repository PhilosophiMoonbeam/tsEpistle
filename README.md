<div align="center">

# tsFranki

[![Release](https://img.shields.io/github/v/release/PhilosophiMoonbeam/wiki?include_prereleases&label=preview)](https://github.com/PhilosophiMoonbeam/wiki/releases)
[![License](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)
[![Build + Publish](https://github.com/PhilosophiMoonbeam/wiki/actions/workflows/build.yml/badge.svg)](https://github.com/PhilosophiMoonbeam/wiki/actions/workflows/build.yml)

**An independent community fork derived from Wiki.js.**

</div>

tsFranki is an experimental, long-lived community fork of [Wiki.js](https://github.com/Requarks/wiki). It is not an official Wiki.js release and is not produced or endorsed by Nicolas Giard or Requarks.

- **Preview version:** `0.1.0-alpha.1`
- **Upstream base:** Wiki.js `2.5.314`
- **Source repository:** [PhilosophiMoonbeam/wiki](https://github.com/PhilosophiMoonbeam/wiki)
- **Container images:** `ghcr.io/philosophimoonbeam/wiki`

The running application exposes its exact Git revision and a **Source Code** link in Setup, Administration → System, and the site footer. That link identifies the source corresponding to the deployed artifact.

## Release status

No supported tsFranki release has been published yet. Do not treat `main`, a canary image, or a locally built image as a production release. The first external release is gated on the repository's full CI matrix, upgrade/restore canaries, and an independent security review.

When a release is published:

1. use an immutable version tag or image digest, never `main` or `canary`;
2. verify the release attestation, then verify the attached archives, Helm chart, SBOM, production dependency license inventory, and `release-manifest.json` against `SHA256SUMS`;
3. back up both the tsFranki data directory and database before every upgrade;
4. test the upgrade against a restored copy of production data;
5. roll back by restoring both the pre-upgrade database and data-directory snapshots—database migrations are not guaranteed to be reversible.

tsFranki supports PostgreSQL 15, 16, 17, and 18 and requires a current minor release within one of those major lines. Startup rejects older and newer major versions before running application migrations. The only supported upstream database upgrade source is exactly Wiki.js 2.5.314. Release CI performs fresh-install and retained Wiki.js 2.5.314 PostgreSQL upgrade checks on every supported major. Other database engines are unsupported; no cross-engine converter is shipped. Older Wiki.js or tsFranki database sources are unsupported unless a later release explicitly adds a retained upgrade fixture. Deployment-specific identity providers, object storage, search engines, mail, proxies, and multi-instance topologies still require an operator canary. Kubernetes users should start with the [fork Helm chart](dev/helm/README.md).

### Verify release provenance

Every published release includes `release-manifest.json`, `SHA256SUMS`, and `tsfranki-release.intoto.jsonl`. The manifest binds the exact source revision, immutable multi-platform image digest, and release artifact hashes. GitHub Actions signs the listed artifacts with keyless Sigstore attestations and pushes provenance plus the SPDX SBOM attestation for the image digest.

```console
gh attestation verify tsfranki-linux.tar.gz \
  --repo PhilosophiMoonbeam/wiki \
  --signer-workflow PhilosophiMoonbeam/wiki/.github/workflows/build.yml \
  --bundle tsfranki-release.intoto.jsonl
sha256sum --check SHA256SUMS
gh attestation verify "oci://ghcr.io/philosophimoonbeam/wiki@IMAGE_DIGEST" \
  --repo PhilosophiMoonbeam/wiki \
  --signer-workflow PhilosophiMoonbeam/wiki/.github/workflows/build.yml \
  --bundle-from-oci
```

Replace `IMAGE_DIGEST` with the digest in `release-manifest.json`. The tag release gate independently rebuilds the Linux bundle in a clean job and requires a byte-for-byte match before publication. Source, Helm, SBOM, and license artifacts are integrity-bound and attested but are not currently claimed to be independently reproducible.

## Install and operate

The release page is the source for the versioned Linux archive, corresponding source archive, Helm chart, SPDX SBOM, dependency license inventory, and checksums. Official binary artifacts are the Linux archive and Linux container images; Windows archives are not published or supported.

For a local PostgreSQL deployment using Docker Compose:

```console
install -m 600 /dev/null wiki-db-password
printf '%s\n' 'replace-with-a-strong-password' > wiki-db-password
WIKI_DB_PASSWORD_FILE="$PWD/wiki-db-password" docker compose -f dev/examples/docker-compose.yml up -d
```

Set `WIKI_IMAGE` to an immutable version tag or digest to override the sample's default version. Put TLS at a maintained reverse proxy; the sample exposes HTTP on port 80.

Kubernetes installation, upgrade, backup, rollback, and restore procedures are in the [fork Helm chart guide](dev/helm/README.md). Before any upgrade, preserve the database and any local asset/data volumes as one recoverable point in time. A binary or container rollback without the matching database restore is unsafe after a migration.

### Backup and rollback contract

Stop every tsFranki instance before restoring. Restore the database and `/wiki/data` from the same pre-upgrade point, then start the exact previous application image digest. Never run an older application against a database migrated by a newer release.

PostgreSQL backups use `pg_dump --format=custom`; restore by recreating the database and running `pg_restore`. The `upgrade` CI matrix verifies the retained Wiki.js 2.5.314 fixture checksum, upgrades it on PostgreSQL 15 through 18, writes post-upgrade database and volume sentinels, restores both pre-upgrade snapshots, boots the old image, authenticates the original administrator, and rejects retained post-upgrade state. Treat that matrix as a compatibility canary, not as a substitute for testing a restored copy of production data.

Each upgrade job uploads `migration-metrics-postgres-<major>.json`. The retained source fixture must migrate and reach health within 120 seconds, add no more than 256 MiB or 5× its original database size, and add no more than 64 MiB to `/wiki/data`. These are regression ceilings for the synthetic compatibility fixture; operators must establish tighter time and capacity budgets from a production-data canary.

## API compatibility

`/api/v1` is the versioned external REST contract. Its OpenAPI 3.1 document is served at `/api/v1/openapi.json` and is covered by contract tests. Additive fields and endpoints may appear in a preview release; an incompatible request or response change requires a new API version. Removal of a v1 operation requires marking it deprecated in OpenAPI and release notes for at least one published preview release first.

GraphQL, `/_api`, browser payloads, database tables, and extension internals are implementation interfaces and have no cross-release compatibility guarantee. API keys inherit the permissions and page rules of their assigned group.

## Agentic knowledge

The built-in Wiki Agent and remote MCP clients share one permission-aware action kernel and one public `wiki_*` tool vocabulary. Internal dotted action IDs exist only for authority, feature admission, and durable audit records. An approved `SKILL.md` can therefore give either kind of agent the same exact operations without transport-specific aliases.

Wiki source pages remain the only human-editable authority. Every committed page revision produces an immutable deterministic knowledge projection containing stable concept identity, sections, links, lifecycle/trust fields, declared gaps, and field-level provenance. The configured global utility model may fill only those declared gaps for the current public revision; private pages are never sent to the provider, provider failures leave a usable partial projection, and revision/hash fences discard stale utility output. Ordinary `wiki_get_page`, search, discovery, recent, version, and related-page operations return the applicable projection through the same action kernel for built-in and MCP agents.

Markdown pages cross interchange boundaries as deterministic [Open Knowledge Format 0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) documents through the `wiki://pages/{locale}/{path}` MCP resource. OKF is a serialization of the same authoritative page and current projection, not an agent tool, store, import workflow, or alternate write path. Normal page proposals remain the only agent authoring path.

The MCP endpoint is built directly on the official Model Context Protocol TypeScript SDK v2, supports the current `2026-07-28` protocol, and retains tested legacy negotiation. Deployment, security, projection, and interchange details are in [Agent deployment and operations](docs/agents-deployment.md).

## Development and local CI

The project uses [Bun](https://bun.com/) as its only JavaScript runtime and package manager. The exact version is pinned in `package.json`; direct dependency versions are exact and the committed `bun.lock` is immutable in CI.

```console
bun install --frozen-lockfile
bun run ci
```

Start the development server and Vite client together:

```console
bun run dev
```

Vite startup provisions the same-origin static and lazy Prism assets used by the server, so development works from a clean checkout without a prebuilt `assets` directory.

`bun run ci` is the local quality contract: dependency and license policy, Biome lint, all three TypeScript boundaries, OpenAPI and release-input checks, Bun's native test runner, and the production Vite build. `bun run format` applies the repository's Biome formatter. Biome owns JavaScript and TypeScript linting; Vue and Pug correctness remains covered by `vue-tsc`, Vite compilation, and browser tests.

GitHub is the orchestration and reporting plane, not the compute plane. Every workflow targets one Linux x64 self-hosted runner carrying the custom `tsfranki-ci` label. The runner must provide the pinned Bun version, Git, Docker with Buildx/QEMU, and enough local capacity for the PostgreSQL, Playwright, upgrade, and Kubernetes jobs. GitHub receives the normal per-job checks, logs, artifacts, attestations, and release gates from that local runner.

The full functional, accessibility, responsive, and performance browser suite runs once against PostgreSQL 18. Database migration and retained-upgrade jobs cover every supported PostgreSQL major independently; duplicating database-agnostic browser workflows across that matrix only increases local-runner contention and flake surface.

Because this repository is public, untrusted pull-request code is never executed automatically on the persistent self-hosted machine. The main workflow runs for trusted branch pushes and manual dispatches; branch commit checks appear on their pull requests. Windows and macOS CI and binary archives are intentionally unsupported. ARM64 containers are cross-built on the Linux x64 runner with QEMU.

## Branch model

- [`main`](https://github.com/PhilosophiMoonbeam/wiki/tree/main) is the authoritative tsFranki product branch. Releases and deployments originate from it.
- [`upstream-main`](https://github.com/PhilosophiMoonbeam/wiki/tree/upstream-main) is a read-only mirror of `requarks/wiki:main`; fork-specific commits do not land there.
- Upstream updates are merged into a short-lived integration branch, adapted and verified there, then submitted to `main`. Product history is not rebased onto upstream.


## Fork attribution and license

This fork was materially modified on 2026-08-13. The modification notice does not claim ownership of upstream work.

Wiki.js was created by Nicolas Giard and developed by Requarks and its contributors. Their copyright, contributor credits, trademarks, and historical notices are preserved. See the [upstream project](https://github.com/Requarks/wiki) for official Wiki.js releases and documentation.

tsFranki remains licensed under the [GNU Affero General Public License version 3](LICENSE). Anyone interacting with a deployed modified version over a network must be offered the complete Corresponding Source for that exact version. Release source archives and the revision-specific source link include the build scripts, patches, lockfile, Dockerfiles, and other tracked build inputs.

## Upstream project credits and funding

The historical sponsorship, contributor, and service-provider acknowledgements below belong to the upstream Wiki.js project and are retained for attribution.

<h2 align="center">Donate</h2>

<div align="center">

Wiki.js is an open source project that has been made possible due to the generous contributions by community [backers](https://js.wiki/about). If you are interested in supporting this project, please consider [becoming a sponsor](https://github.com/users/NGPixel/sponsorship), [becoming a patron](https://www.patreon.com/requarks), donating to our [OpenCollective](https://opencollective.com/wikijs), via [Paypal](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=FLV5X255Z9CJU&source=url) or via Ethereum (`0xe1d55c19ae86f6bcbfb17e7f06ace96bdbb22cb5`).
  
  [![Become a Sponsor](https://img.shields.io/badge/donate-github-ea4aaa.svg?style=popout&logo=github)](https://github.com/users/NGPixel/sponsorship)
  [![Become a Patron](https://img.shields.io/badge/donate-patreon-orange.svg?style=popout&logo=patreon)](https://www.patreon.com/requarks)
  [![Donate on OpenCollective](https://img.shields.io/badge/donate-open%20collective-blue.svg?style=popout&logo=data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIHdpZHRoPSIyNTZweCIgaGVpZ2h0PSIyNTZweCIgdmlld0JveD0iMCAwIDI1NiAyNTYiIHZlcnNpb249IjEuMSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayIgcHJlc2VydmVBc3BlY3RSYXRpbz0ieE1pZFlNaWQiPjxnPjxwYXRoIGQ9Ik0yMDkuNzY1MTQ0LDEyOC4xNDk5NzkgQzIwOS43NjUxNDQsMTQ0LjE2MzMgMjA0Ljg2NDM4MSwxNTkuNDg5ODkgMTk2LjQ5ODc0NywxNzIuNzI1MDcyIEwyMjkuOTQ1Njc1LDIwNi4xNzE5OTkgQzI0Ni42ODIxMDUsMTgzLjg1Njc1OSAyNTUuNzI5MzA3LDE1Ni43MTUxNTIgMjU1LjcyOTMwNywxMjguODIxMTAyIEMyNTUuNzI5MzA3LDk5LjU1Njk5MTcgMjQ1Ljk3NDYwMyw3My4wNzEwMjA3IDIyOS4yNTg5NDQsNTEuNDg1ODEyOCBMMTk2LjQ4MzE0LDg0LjIxNDc5NCBDMjA1LjEyMjU2MSw5Ny4yMjI0NjgzIDIwOS43MzY5MDcsMTEyLjQ4NzgxIDIwOS43NDk1MzcsMTI4LjEwMzE1NiBMMjA5Ljc2NTE0NCwxMjguMTQ5OTc5IFoiIGZpbGw9IiNCOEQzRjQiPjwvcGF0aD48cGF0aCBkPSJNMTI3LjUxMzQ4NCwyMTAuMzU0ODE2IEM4Mi4xNDYwODcyLDIxMC4yNjg5NTggNDUuMzg3NTA5NCwxNzMuNTE3MzU4IDQ1LjI5MzAzOTMsMTI4LjE0OTk3OSBDNDUuMzYxNzUwMiw4Mi43NjQzMTM4IDgyLjEyNzg0ODcsNDUuOTg0MjU3IDEyNy41MTM0ODQsNDUuODk4MzE4NiBDMTQ0LjI0NDc1Miw0NS44OTgzMTg2IDE1OS41NzEzNDIsNTAuNzk5MDgxNyAxNzIuMTE5NzkyLDU5LjE2NDcxNTQgTDIwNC44NjQzODEsMjYuMzg4OTExNiBDMTgyLjU0MzY1LDkuNjY2NjUxMjkgMTU1LjQwMzQyOSwwLjYzMDg2MzI5OCAxMjcuNTEzNDg0LDAuNjM2NDk0NDAzIEM1Ny4xMjM1NDM3LDAuNjM2NDk0NDAzIDAsNTcuNzYwMDM4MSAwLDEyOC4xNDk5NzkgQzAsMTk4LjUwODcwNCA1Ny4xMjM1NDM3LDI1NS42NjM0NjMgMTI3LjUxMzQ4NCwyNTUuNjYzNDYzIEMxNTUuNTM3MzUyLDI1NS43NDA4NzYgMTgyLjc3NTk4OSwyNDYuNDA4NTEgMjA0Ljg2NDM4MSwyMjkuMTYxODg0IEwxNzEuNDE3NDU0LDE5NS43MzA1NjQgQzE1OS41NTU3MzQsMjA1LjQ4NTI2OCAxNDQuMjYwMzU5LDIxMC4zNTQ4MTYgMTI3LjUxMzQ4NCwyMTAuMzU0ODE2IEwxMjcuNTEzNDg0LDIxMC4zNTQ4MTYgWiIgZmlsbD0iIzdGQURGMiI+PC9wYXRoPjwvZz48L3N2Zz4=)](https://opencollective.com/wikijs)
  [![Donate via Paypal](https://img.shields.io/badge/donate-paypal-blue.svg?style=popout&logo=paypal)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=FLV5X255Z9CJU&source=url)  
  [![Donate via Ethereum](https://img.shields.io/badge/donate-ethereum-999.svg?style=popout&logo=ethereum&logoColor=CCC)](https://etherscan.io/address/0xe1d55c19ae86f6bcbfb17e7f06ace96bdbb22cb5)
  [![Donate via Bitcoin](https://img.shields.io/badge/donate-bitcoin-ff9900.svg?style=popout&logo=bitcoin&logoColor=CCC)](https://checkout.opennode.com/p/2553c612-f863-4407-82b3-1a7685268747)
  [![Buy a T-Shirt](https://img.shields.io/badge/buy-t--shirts-teal.svg?style=popout&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHg9IjBweCIgeT0iMHB4Igp3aWR0aD0iMjQiIGhlaWdodD0iMjQiCnZpZXdCb3g9IjAgMCAxOTIgMTkyIgpzdHlsZT0iIGZpbGw6IzAwMDAwMDsiPjxnIGZpbGw9Im5vbmUiIGZpbGwtcnVsZT0ibm9uemVybyIgc3Ryb2tlPSJub25lIiBzdHJva2Utd2lkdGg9IjEiIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHN0cm9rZS1kYXNoYXJyYXk9IiIgc3Ryb2tlLWRhc2hvZmZzZXQ9IjAiIGZvbnQtZmFtaWx5PSJub25lIiBmb250LXdlaWdodD0ibm9uZSIgZm9udC1zaXplPSJub25lIiB0ZXh0LWFuY2hvcj0ibm9uZSIgc3R5bGU9Im1peC1ibGVuZC1tb2RlOiBub3JtYWwiPjxwYXRoIGQ9Ik0wLDE5MnYtMTkyaDE5MnYxOTJ6IiBmaWxsPSJub25lIj48L3BhdGg+PGcgZmlsbD0iIzFhYmM5YyI+PGcgaWQ9InN1cmZhY2UxIj48cGF0aCBkPSJNOTYsMGMtMTUuMjE4NzUsMCAtMjQuNjg3NSwzLjY1NjI1IC0yNS41LDRsLTIyLjUsNy4yNWMtMTAuNDA2MjUsMy4xODc1IC0xOS4wOTM3NSw5LjQzNzUgLTI1LjUsMTguMjVsLTIyLjUsNDIuNWwyNy4yNSwxNi43NWwxMi43NSwtMjR2MTE5LjI1YzAsNC40MDYyNSAyNS4wNjI1LDggNTYsOGMzMC45Mzc1LDAgNTYsLTMuNTkzNzUgNTYsLTh2LTExOS4yNWwxMi43NSwyNGwyNy4yNSwtMTYuNzVsLTIyLjUsLTQyLjVjLTYuNDA2MjUsLTguODEyNSAtMTUuMTU2MjUsLTE1LjA2MjUgLTI0Ljc1LC0xOC4yNWwtMjIuMjUsLTcuMjVjLTAuMTg3NSwwIC0xLjAzMTI1LDEuMzEyNSAtMiwyLjc1bDEuMjUsLTIuNWMwLDAgLTkuODQzNzUsLTQuMjUgLTI1Ljc1LC00LjI1ek05Niw4YzExLjQwNjI1LDAgMTguNDM3NSwyLjI1IDIxLDMuMjVjLTQuNDY4NzUsNS43NSAtMTEuNDA2MjUsMTIuNzUgLTIxLDEyLjc1Yy05LjQwNjI1LDAgLTE2LjQwNjI1LC03LjA2MjUgLTIwLjc1LC0xMi43NWMyLjg3NSwtMS4wNjI1IDkuODc1LC0zLjI1IDIwLjc1LC0zLjI1eiI+PC9wYXRoPjwvZz48L2c+PC9nPjwvc3ZnPg==)](https://wikijs.threadless.com)

</div>

<h2 align="center">Gold Tier Sponsors</h2>

<div align="center">
<table>
  <tbody>
    <tr>
      <td align="center" valign="middle" width="444">
        <a href="https://trans-zero.com/" target="_blank">
          <img src="https://cdn.js.wiki/images/sponsors/transzero.png">
        </a>
      </td>
    </tr>
  </tbody>
</table>
</div>

<h2 align="center">GitHub Sponsors</h2>

Support this project by becoming a sponsor. Your name will show up in the Contribute page of all Wiki.js installations as well as here with a link to your website! [[Become a sponsor](https://github.com/users/NGPixel/sponsorship)]

<div align="center">
<table>
  <tbody>
    <tr>
      <td align="center" valign="middle" width="444">
        <a href="https://www.stellarhosted.com/" target="_blank">
          <img src="https://cdn.js.wiki/images/sponsors/stellarhosted.png">
        </a>
      </td>
    </tr>
  </tbody>
</table>
</div>

<div align="center">
<table>
  <tbody>
    <tr>
      <td align="center" valign="middle" width="130">
        <a href="https://acceleanation.com/" target="_blank">
          <img src="https://avatars.githubusercontent.com/u/41210718?s=200&v=4">
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="https://github.com/alexksso" target="_blank">
          Alexander Casassovici<br />(@alexksso)
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="https://github.com/broxen" target="_blank">
          Broxen<br />(@broxen)
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="https://github.com/xDacon" target="_blank">
          Dacon<br />(@xDacon)
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="https://github.com/DonNabla" target="_blank">
          Maxime Pierre<br />(@DonNabla)
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="https://github.com/GigabiteLabs" target="_blank">
          <img src="https://static.requarks.io/sponsors/gigabitelabs-148x129.png">
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="https://www.hostwiki.com/" target="_blank">
          <img src="https://cdn.js.wiki/images/sponsors/hostwiki.png">
        </a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle" width="130">
        <a href="https://github.com/JayDaley" target="_blank">
          Jay Daley<br />(@JayDaley)
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="https://github.com/idokka" target="_blank">
          Oleksii<br />(@idokka)
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="https://www.openhost-network.com/" target="_blank">
          <img src="https://avatars.githubusercontent.com/u/114218287?s=200&v=4">
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="https://www.prevo.ch/" target="_blank">
          <img src="https://avatars.githubusercontent.com/u/114394792?v=4">
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="https://github.com/shanekearney" target="_blank">
          Shane Kearney<br />(@shanekearney)
        </a>
      </td>
      <td align="center" valign="middle" width="130">
        <a href="http://www.taicep.org/" target="_blank">
          <img src="https://avatars.githubusercontent.com/u/160072306?v=4">
        </a>
      </td>
      <td align="center" valign="middle" width="130"></td>
    </tr>
  </tbody>
</table>

<table><tbody><tr><td>
<img width="441" height="1" />

- Akira Suenami ([@a-suenami](https://github.com/a-suenami))
- Armin Reiter ([@arminreiter](https://github.com/arminreiter))
- Arnaud Marchand ([@snuids](https://github.com/snuids))
- Brian Douglass ([@bhdouglass](https://github.com/bhdouglass))
- Bryon Vandiver ([@asterick](https://github.com/asterick))
- Cameron Steele ([@ATechAdventurer](https://github.com/ATechAdventurer))
- Charlie Schliesser ([@charlie-s](https://github.com/charlie-s))
- Cloud Data Hosting LLC ([@CloudDataHostingLLC](https://github.com/CloudDataHostingLLC))
- Cole Manning ([@RVRX](https://github.com/RVRX))
- CrazyMarvin ([@CrazyMarvin](https://github.com/CrazyMarvin))
- Daniel Horner ([@danhorner](https://github.com/danhorner))
- David Christian Holin ([@SirGibihm](https://github.com/SirGibihm))
- Dragan Espenschied ([@despens](https://github.com/despens))
- Elijah Zobenko ([@he110](https://github.com/he110))
- Emerson-Perna ([@Emerson-Perna](https://github.com/Emerson-Perna))
- Ernie ([@iamernie](https://github.com/iamernie))
- Fabio Ferrari ([@devxops](https://github.com/devxops))
- Finsa S.p.A. ([@finsaspa](https://github.com/finsaspa))
- Florian Moss ([@florianmoss](https://github.com/florianmoss))
- GoodCorporateCitizen ([@GoodCorporateCitizen](https://github.com/GoodCorporateCitizen))
- HeavenBay ([@HeavenBay](https://github.com/heavenbay))
- HikaruEgashira ([@HikaruEgashira](https://github.com/HikaruEgashira))
- Ian Hyzy ([@ianhyzy](https://github.com/ianhyzy))
- Jaimyn Mayer ([@jabelone](https://github.com/jabelone))
- Jay Lee ([@polyglotm](https://github.com/polyglotm))
- Kelly Wardrop ([@dropcoded](https://github.com/dropcoded))
- Loki ([@binaryloki](https://github.com/binaryloki))
- MaFarine ([@MaFarine](https://github.com/MaFarine))
- Marcilio Leite Neto ([@marclneto](https://github.com/marclneto))
- Mattias Johnson ([@mattiasJohnson](https://github.com/mattiasJohnson))
- Max Ricketts-Uy ([@MaxRickettsUy](https://github.com/MaxRickettsUy))
- Mickael Asseline ([@PAPAMICA](https://github.com/PAPAMICA))
- Mitchell Rowton ([@mrowton](https://github.com/mrowton))
        
</td><td>
<img width="441" height="1" />

- M. Scott Ford ([@mscottford](https://github.com/mscottford))
- Nick Halase ([@nhalase](https://github.com/nhalase))
- Nick Price ([@DominoTree](https://github.com/DominoTree))
- Nina Reynolds ([@cutecycle](https://github.com/cutecycle))
- Noel Cower ([@nilium](https://github.com/nilium))
- Oleksandr Koltsov ([@crambo](https://github.com/crambo))
- Phi Zeroth ([@phizeroth](https://github.com/phizeroth))
- Philipp Schmitt ([@pschmitt](https://github.com/pschmitt))
- Robert Lanzke ([@winkelement](https://github.com/winkelement))
- Ruizhe Li ([@liruizhe1995](https://github.com/liruizhe1995))
- Sam Martin ([@ABitMoreDepth](https://github.com/ABitMoreDepth))
- Sean Coffey ([@seanecoffey](https://github.com/seanecoffey))
- Simon Ott ([@ottsimon](https://github.com/ottsimon))
- Stephan Kristyn ([@stevek-pro](https://github.com/stevek-pro))
- Theodore Chu ([@TheodoreChu](https://github.com/TheodoreChu))
- Tim Elmer ([@tim-elmer](https://github.com/tim-elmer))
- Tyler Denman ([@tylerguy](https://github.com/tylerguy))
- Victor Bilgin ([@vbilgin](https://github.com/vbilgin))
- VMO Solutions ([@vmosolutions](https://github.com/vmosolutions))
- YazMogg35 ([@YazMogg35](https://github.com/YazMogg35))
- Yu Yongwoo ([@uyu423](https://github.com/uyu423))
- ameyrakheja ([@ameyrakheja](https://github.com/ameyrakheja))
- aniketpanjwani ([@aniketpanjwani](https://github.com/aniketpanjwani))
- aytaa ([@aytaa](https://github.com/aytaa))
- cesar ([@cesarnr21](https://github.com/cesarnr21))
- chaee ([@chaee](https://github.com/chaee))
- lwileczek ([@lwileczek](https://github.com/lwileczek))
- magicpotato ([@fortheday](https://github.com/fortheday))
- motoacs ([@motoacs](https://github.com/motoacs))
- muzian666 ([@muzian666](https://github.com/muzian666))
- rburckner ([@rburckner](https://github.com/rburckner))
- scorpion ([@scorpion](https://github.com/scorpion))
- valantien ([@valantien](https://github.com/valantien))
        
</td></tr></tbody></table>
</div>

<h2 align="center">OpenCollective Sponsors</h2>

Support this project by becoming a sponsor. Your logo will show up in the Contribute page of all Wiki.js installations as well as here with a link to your website! [[Become a sponsor](https://opencollective.com/wikijs#sponsor)]

<div align="center">
<table>
  <tbody>
    <tr>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/0/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/0/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/1/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/1/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/2/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/2/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/3/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/3/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/4/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/4/avatar.svg"></a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/5/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/5/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/6/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/6/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/7/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/7/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/8/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/8/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/9/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/9/avatar.svg"></a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/10/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/10/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/11/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/11/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/12/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/12/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/13/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/13/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/14/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/14/avatar.svg"></a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/15/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/15/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/16/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/16/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/17/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/17/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/18/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/18/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/19/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/19/avatar.svg"></a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/20/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/20/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/21/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/21/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/22/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/22/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/23/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/23/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/24/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/24/avatar.svg"></a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/25/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/25/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/26/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/26/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/27/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/27/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/28/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/28/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/29/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/29/avatar.svg"></a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/30/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/30/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/31/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/31/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/32/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/32/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/33/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/33/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/34/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/34/avatar.svg"></a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/35/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/35/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/36/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/36/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/37/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/37/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/38/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/38/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/39/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/39/avatar.svg"></a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/40/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/40/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/41/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/41/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/42/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/42/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/43/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/43/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/44/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/44/avatar.svg"></a>
      </td>
    </tr>
    <tr>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/40/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/45/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/41/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/46/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/42/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/47/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/43/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/48/avatar.svg"></a>
      </td>
      <td align="center" valign="middle">
        <a href="https://opencollective.com/wikijs/sponsor/44/website" target="_blank"><img src="https://opencollective.com/wikijs/sponsor/49/avatar.svg"></a>
      </td>
    </tr>
  </tbody>
</table>
</div>

<h2 align="center">Patreon Backers</h2>

Thank you to all our patrons! 🙏 [[Become a patron](https://www.patreon.com/requarks)]

<div align="center">
<table><tbody><tr><td>
<img width="441" height="1" />

- Aeternum
- Al Romano
- Alex Balabanov
- Alex Milanov
- Alex Zen
- Arti Zirk
- Ave
- Brandon Curtis
- Damien Hottelier
- Daniel T. Holtzclaw
- Dave 'Sri' Seah
- djagoo
- dz
- Douglas Lassance
- Ergoflix
- Ernie Reid
- Etienne
- Flemis Jurgenheimer
- Florent
- Günter Pavlas
- hong
- Hope
- Ian
- Imari Childress
- Iskander Callos
  
</td><td>
<img width="441" height="1" />

- Josh Stewart
- Justin Dunsworth
- Keir
- Loïc CRAMPON
- Ludgeir Ibanez
- Lyn Matten
- Mads Rosendahl
- Mark Mansur
- Matt Gedigian
- Mike Ditton
- Nate Figz
- Patryk
- Paul O'Fallon
- Philipp Schürch
- Tracey Duffy
- Quaxim
- Richeir
- Sergio Navarro Fernández
- Shad Narcher
- ShadowVoyd
- SmartNET.works
- Stepan Sokolovskyi
- Zach Crawford
- Zach Maynard
- 张白驹

</td></tr></tbody></table>
</div>

<h2 align="center">OpenCollective Backers</h2>

Thank you to all our backers! 🙏 [[Become a backer](https://opencollective.com/wikijs#backer)]

<a href="https://opencollective.com/wikijs#backers" target="_blank"><img src="https://opencollective.com/wikijs/backers.svg?width=890"></a>

<h2 align="center">Contributors</h2>

This project exists thanks to all the people who contribute. [[Contribute]](https://github.com/Requarks/wiki/blob/master/.github/CONTRIBUTING.md).
<a href="https://github.com/Requarks/wiki/graphs/contributors"><img src="https://opencollective.com/wikijs/contributors.svg?width=890" /></a>

<h2 align="center">Special Thanks</h2>

![Browserstack](https://js.wiki/legacy/logo_browserstack.png)  
[Browserstack](https://www.browserstack.com/) for providing access to their great cross-browser testing tools.

![Cloudflare](https://js.wiki/legacy/logo_cloudflare.png)  
[Cloudflare](https://www.cloudflare.com/) for providing their great CDN, SSL and advanced networking services.

![DigitalOcean](https://js.wiki/legacy/logo_digitalocean.png)  
[DigitalOcean](https://m.do.co/c/5f7445bfa4d0) for providing hosting of the Wiki.js documentation site and APIs.

![Icons8](https://static.requarks.io/logo/icons8-text-h40.png)  
[Icons8](https://icons8.com/) for providing access to their beautiful icon sets.

![Lokalise](https://static.requarks.io/logo/lokalise-text-h40.png)  
[Lokalise](https://lokalise.com/) for providing access to their great localization tool.

![MacStadium](https://static.requarks.io/logo/macstadium-h40.png)  
[MacStadium](https://www.macstadium.com) for providing access to their Mac hardware in the cloud.

![Netlify](https://js.wiki/legacy/logo_netlify.png)  
[Netlify](https://www.netlify.com) for providing hosting for our website.

![ngrok](https://static.requarks.io/logo/ngrok-h40.png)  
[ngrok](https://ngrok.com) for providing access to their great HTTP tunneling services.

![Porkbun](https://static.requarks.io/logo/porkbun.png)  
[Porkbun](https://www.porkbun.com) for providing domain registration services.
