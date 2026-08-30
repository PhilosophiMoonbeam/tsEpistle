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
