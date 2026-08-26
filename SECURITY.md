# Security Policy

tsFranki is an independent community fork of Wiki.js. Security reports for this fork must be sent to the tsFranki maintainers, not to Requarks or the upstream Wiki.js project.

## Supported versions

| Version | Security support |
| --- | --- |
| Latest published `0.1.0-alpha.x` release | Best effort |
| `main`, canary images, and untagged builds | Unsupported |
| Upstream Wiki.js releases | Report to the [upstream project](https://github.com/Requarks/wiki/security/policy) |

Preview releases are not recommended for deployments whose availability, confidentiality, or data-retention requirements cannot tolerate alpha software.

## Threat model

The maintained [security threat model](docs/security/threat-model.md) defines assets, trust boundaries, executable control evidence, residual risks, and release-blocking findings. Every authentication, authorization, renderer, extension, worker, import/export, migration, or deployment-boundary change must update that model and its regression evidence.

Passing automated tests is not an independent security review. The first external release remains blocked until the threat model's external-review record is completed for a frozen revision.


## Reporting a vulnerability

Do not create a public issue, discussion, or pull request for a suspected vulnerability.

Submit a private report through [GitHub private vulnerability reporting](https://github.com/PhilosophiMoonbeam/wiki/security/advisories/new). Include:

- the affected tsFranki version and exact Git revision;
- reproduction steps and the expected security boundary;
- deployment details relevant to the report, including database engine and reverse proxy;
- impact, logs, or a proof of concept with secrets and personal data removed;
- any mitigation or proposed fix.

The maintainers will acknowledge the report through the private advisory, assess impact, and coordinate remediation and disclosure there. No response-time or bounty commitment is currently offered.

## Release provenance

Official releases are GitHub releases from this repository. Each release contains Linux and Windows archives, corresponding source, the Helm chart, an SPDX SBOM, a production dependency license inventory, and `SHA256SUMS`; container images are published under `ghcr.io/philosophimoonbeam/wiki` with BuildKit provenance and SBOM attestations. The running application exposes its exact source revision.
