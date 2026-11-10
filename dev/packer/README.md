# DigitalOcean image build

The `Build DigitalOcean Image` workflow builds a release snapshot only from immutable runtime inputs. Operators dispatch it with:

```sh
gh workflow run packer.yml \
  --field version=3.2.1 \
  --field apt_snapshot=20260830T120000Z
```

`version` must identify an existing attested release whose manifest binds the version, Git revision, and digest-pinned Wiki container image. `apt_snapshot` is an existing Ubuntu archive snapshot timestamp in `YYYYMMDDTHHMMSSZ` form. Select a timestamp published by [snapshot.ubuntu.com](https://snapshot.ubuntu.com/); it fixes the `noble`, `noble-updates`, `noble-backports`, and `noble-security` repositories used for upgrades and dependency installation.

Before Packer starts, `scripts/resolve-runtime-inputs.sh`:

1. resolves the `ubuntu-24-04-x64` distribution slug through the DigitalOcean API and passes its numeric image ID;
2. resolves `docker.io/library/postgres:17` to its registry digest and verifies the digest descriptor still matches the tag response;
3. verifies every requested Ubuntu snapshot suite exists;
4. resolves and downloads the five Docker Engine packages for `linux/amd64`, then records each package name, version, architecture, filename, and SHA-256 digest.

The build fails rather than using a tag, slug, live apt mirror, or package-name fallback when any identity cannot be resolved or validated. Packer receives only the numeric DigitalOcean image ID, the Ubuntu snapshot timestamp, the digest-pinned PostgreSQL reference, and the verified Docker package bundle and manifest.

The Packer manifest `custom_data` records those identities alongside the application digest, release version, and source revision. The uploaded `snapshot-provenance.json` embeds the complete `runtimeInputs` record, including every Docker package digest. The same record is installed in the image as `/etc/wiki/snapshot-provenance-inputs.json` for incident response. A build with different base-image, PostgreSQL, Ubuntu archive, or Docker package bytes therefore has different provenance even when the Wiki release inputs are unchanged.

## Firstboot and image validation

These contracts are implemented under `tsEpistle-q0g.5`–`.7`. PostgreSQL 17, immutable inputs and interactive first-administrator setup remain unchanged; no generated administrator password, Caddy or Compose migration is introduced. Image publication remains a separately authorized operation.

- **Firstboot (`.5`):** the image contains only an empty regular credential placeholder, never a generated password. The host directory is root-owned `0700`; individual read-only file binds let Wiki UID 1000 and PostgreSQL read the `0444` file without exposing its host directory. Firstboot atomically generates one instance credential, preserves it on retry, and refuses unusable credentials or an empty credential after the database container has started. Wiki starts only after bounded TCP database readiness. Only the recognized owned SSH drop-in is released on success or failure; unrelated SSH policy and secret bytes remain private.
- **Image checker (`.6`):** failed or indeterminate apt refresh/inspection is critical. Count actual unique security-package installation records, including one record, without line-pair assumptions. Residual-log diagnostics identify paths without copying contents. Firewall checks use the service's exit status, not captured output; inactive services remain warnings without masking critical findings. Account aggregation and SSH-key redaction remain enforced.
- **Cleanup (`.7`):** zero-fill must use a lifecycle-owned temporary file removed on every exit. Only expected device exhaustion plus successful removal may succeed; unrelated write errors, unexpected success, interruption and removal failures must remain failures. Zero-fill is not a general secure-erasure guarantee.

Run the focused `packer-firstboot`, `packer-release-provenance` and `packer-cleanup` tests through `bun run test` with their exact filenames. Root-admitted checker and startup qualification belongs only in disposable isolated guests, including fresh instance, retry and failure cases. Never run provisioning, cleanup or image checks against workstation or maintained-host paths. These contracts do not authorize a provider workflow run or private-controller change.
