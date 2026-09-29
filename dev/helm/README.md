# tsEpistle Helm chart

This chart deploys **tsEpistle 0.1.0-alpha.1**, an independent community fork derived from Wiki.js 2.5.314. It is not an official Wiki.js release.

- Source: <https://github.com/PhilosophiMoonbeam/tsEpistle>
- License: [AGPL-3.0](../../LICENSE)
- Container: `ghcr.io/philosophimoonbeam/wiki:0.1.0-alpha.1`
- Support: <https://github.com/PhilosophiMoonbeam/tsEpistle/issues>

The chart is preview software. Test upgrades and restores against a non-production copy before deployment.

## Prerequisites

- Kubernetes with a default `ReadWriteOnce` storage class, or an existing PVC
- Helm 3
- PostgreSQL 15, 16, 17, or 18 on a current minor release, plus a verified backup before every application or chart upgrade
- A Kubernetes Secret for database credentials

## Install

Package the chart from a tagged source checkout or download the chart archive from the matching GitHub release:

```console
helm package dev/helm
kubectl create secret generic wiki-postgresql \
  --from-literal=postgresql-username=postgres \
  --from-literal=postgresql-password='replace-with-a-strong-password'
helm install wiki ./tsepistle-0.1.0-alpha.1.tgz \
  --set postgresql.existingSecret=wiki-postgresql
```

The image tag defaults to the chart `appVersion`. Prefer an immutable platform or multi-platform digest in `image.digest`; it takes precedence over `image.tag`. Do not use `canary` or floating `preview` tags in production.

Each pod receives its Kubernetes pod name as `INSTANCE_ID`. Lease ownership and cross-instance notifications therefore identify the exact process that handled the work; do not override this variable with a value shared by multiple replicas.

## Access without an Ingress

When `ingress.enabled=false` and the Service uses its default `ClusterIP` type, forward local port 8080 to Service port 80:

```console
kubectl --namespace default port-forward service/wiki-tsepistle 8080:80
curl --fail http://127.0.0.1:8080/healthz
```

Replace `default` and `wiki-tsepistle` with the release namespace and generated Service name when they differ. Keep the port-forward process running while accessing the application at <http://127.0.0.1:8080>.

## Gateway API HTTPRoute

The chart can create an opt-in `gateway.networking.k8s.io/v1` HTTPRoute. Install the Gateway API CRDs and a Gateway controller first. When enabled, Helm checks that the HTTPRoute API is discoverable and that `parentRefs` contains at least one reference with a name. Hostnames are optional; the default match is a path prefix of `/`.

If `backendRefs` is empty, the route targets this release's Service on `service.port`. Custom backend references must each set a service `name` and integer `port` from 1 through 65535. Enabling `httpRoute` does not disable or alter the existing Ingress, which remains enabled by default; set `ingress.enabled: false` explicitly if the Gateway route should replace it.

```yaml
httpRoute:
  enabled: true
  parentRefs:
    - name: public-gateway
      namespace: gateway-system
      sectionName: web
  hostnames:
    - wiki.example.test
  path:
    type: PathPrefix
    value: /
  # backendRefs: [] uses the chart Service and service.port.
```

## Pod disruption budget

The PDB is disabled by default and uses `policy/v1` (Kubernetes 1.21 or newer). When enabled, set exactly one of `minAvailable` or `maxUnavailable`; integer pod counts cannot exceed `replicaCount`, and percentage strings must be from `0%` through `100%`.

```yaml
podDisruptionBudget:
  enabled: true
  minAvailable: 1
```

A PDB governs voluntary evictions; it does not provide replicas, shared storage, high availability, or protection from the chart's `Recreate` application rollout.


## External PostgreSQL

Disable the bundled PostgreSQL StatefulSet and reference an existing Secret:

```yaml
postgresql:
  enabled: false

externalPostgresql:
  host: postgres.example.internal
  port: "5432"
  database: wiki
  username: wiki
  existingSecret: wiki-database
  existingSecretKey: password
  ssl: true
```

Create the Secret before installing the release. `externalPostgresql.databaseURL` is also supported, but it places credentials in Helm values and release history; the Secret-based fields are preferred.

## Bundled PostgreSQL security contexts

`postgresql.podSecurityContext` and `postgresql.securityContext` pass Kubernetes security-context fields through to the database Pod and container. Both are empty by default. This conservative profile keeps the official `postgres:18` image's entrypoint and the chart's existing database data mount unchanged while enabling the RuntimeDefault seccomp profile, disabling privilege escalation, and removing the unused raw-network capability:

```yaml
postgresql:
  image:
    repository: postgres
    tag: "18"
  podSecurityContext:
    seccompProfile:
      type: RuntimeDefault
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop:
        - NET_RAW
```

The official PostgreSQL image starts its entrypoint as root so it can prepare the configured `PGDATA` and runtime directory, then drops to the `postgres` user. This chart explicitly sets `PGDATA` and keeps the existing `/var/lib/postgresql/data` mount with its `postgresql` subPath. Do not force a UID, `runAsNonRoot`, `fsGroup`, read-only root filesystem, or removal of the entrypoint's ownership/UID-switch capabilities onto a retained database claim. The chart does not add an init-container or a new ownership rewrite; a stricter no-root/read-only profile requires separate verification against the selected image, writable paths, and claim ownership.


## Upgrade
### Existing releases created with `tsfranki` (compatibility-only)

The chart identity changed from `tsfranki` to `tsepistle`. Before upgrading an
existing release that was created with the former chart, add this
compatibility-only setting to the operator values file used for every upgrade:

```yaml
# Compatibility-only for releases created with the former tsfranki chart.
nameOverride: tsfranki
```

Then use that same file when upgrading to the `tsepistle` chart (replace
`wiki` and the chart archive path when your release uses different values):

```console
helm upgrade wiki ./tsepistle-0.1.0-alpha.1.tgz \
  -f values.yaml --wait --timeout 15m
```

If editing the values file is not possible, pass the equivalent override
explicitly on every upgrade:

```console
helm upgrade wiki ./tsepistle-0.1.0-alpha.1.tgz \
  -f values.yaml --set nameOverride=tsfranki \
  --wait --timeout 15m
```

Keeping `nameOverride: tsfranki` preserves the existing `wiki-tsfranki`
Deployment, Service, application-data PVC (`wiki-tsfranki-data`), selectors,
service account, and bundled PostgreSQL StatefulSet, Service, PVC, and Secret
(`wiki-tsfranki-postgresql`). Keep this compatibility-only override set for
all subsequent upgrades; removing it can make Helm render new names and bind
new empty claims instead of the existing data.

Fresh installs are different: leave `nameOverride` empty and continue using
the `wiki-tsepistle` names shown in the install and access examples above.


1. Record the current chart version, values, image digest, and database server version.
2. Stop all application writers for a maintenance window before the recovery point.
3. Back up and verify **both** PostgreSQL and `/wiki/data` while writers are stopped; keep the paired archives outside the claims being upgraded. For bundled PostgreSQL, a consistent PVC snapshot can supplement the database backup.
4. Render and inspect the new manifests:

   ```console
   helm lint dev/helm
   helm template wiki ./tsepistle-0.1.0-alpha.1.tgz -f values.yaml > rendered.yaml
   ```

5. Upgrade with an explicit chart and values file:

   ```console
   helm upgrade wiki ./tsepistle-0.1.0-alpha.1.tgz -f values.yaml --wait --timeout 15m
   ```

6. Confirm the Deployment is available, `/healthz` returns HTTP 200, login works, and a read/write page check succeeds.

tsEpistle runs database migrations during startup, so the Deployment intentionally uses the `Recreate` strategy to prevent old and new application versions from sharing one database during an upgrade. Kubernetes stops the old application pods before starting the new version; this avoids mixed-version operation at the cost of application downtime while the replacement pod migrates and becomes ready. Plan every upgrade as a maintenance window. Do not use `--atomic` or `--rollback-on-failure` for this path: neither restores persistent data, and the old image may fail against a migrated schema.

The Helm lifecycle CI installs the supported previous release from an explicit `repository:tag@sha256:digest` reference before upgrading to the candidate. The smoke gate refuses a missing, mutable, unresolved, or same-image previous release and records each distinct Docker image revision in its Helm revision values before testing upgrade and paired-state recovery followed by rollback. Keep this input pinned to an immutable application release that remains inside the supported upgrade window; never create the initial revision by retagging the candidate.

The Linux x64 lifecycle gate pulls that pinned previous-release image directly into each kind node; CI nodes need HTTPS access to the image registry. The installed and rolled-back image reference remains the same immutable digest.

## Backup verification

Back up PostgreSQL in custom format and prove that the archive can restore before changing the application:

```console
pg_dump --format=custom --file=wiki-pre-upgrade.dump "$DATABASE_URL"
pg_restore --list wiki-pre-upgrade.dump >/dev/null
createdb wiki_restore_check
pg_restore --exit-on-error --single-transaction --dbname=wiki_restore_check wiki-pre-upgrade.dump
psql --dbname=wiki_restore_check --command='SELECT COUNT(*) FROM pages;'
dropdb wiki_restore_check
```

Use a dedicated restore-check database on a non-production server. Back up or snapshot `/wiki/data` in the same write-maintenance window and record the database archive checksum, volume snapshot identifier, chart version, values file, and image digest together. A database-only backup is incomplete when local assets or other application data are stored on that volume.

## Rollback and restore

`helm rollback` restores Kubernetes resources, not database or `/wiki/data` contents. If the new application has migrated the database, rolling back only the Deployment can start old code against a newer schema and is unsafe.

1. Stop all tsEpistle pods and other writers; wait until they terminate.
2. Verify the paired recovery-point checksums. Restore the pre-upgrade PostgreSQL database **and** the complete `/wiki/data` contents, removing post-checkpoint files before extraction. Verify both restores while old application pods remain stopped. Writes accepted after the recovery point will not survive this rollback.
3. Only after both restores succeed, roll back the Helm release:

   ```console
   helm history wiki
   helm rollback wiki REVISION --wait --timeout 15m
   ```

4. Confirm `/healthz`, login, and read/write page behavior before reopening traffic. If either restore fails, keep application writers stopped rather than starting the old image against mixed state.

## Uninstall

```console
helm uninstall wiki
```

The chart marks both the application-data and bundled-database PVCs with Helm's `keep` resource policy. Confirm the retained claims before deleting either one:

```console
kubectl get pvc -l app.kubernetes.io/instance=wiki
kubectl delete pvc CLAIM_NAME
```

## Important values

| Parameter | Default | Purpose |
| --- | --- | --- |
| `replicaCount` | `1` | tsEpistle pod count |
| `revisionHistoryLimit` | `2` | Deployment revisions retained |
| `image.repository` | `ghcr.io/philosophimoonbeam/wiki` | Fork image repository |
| `image.tag` | chart `appVersion` | Application image tag |
| `image.digest` | unset | Immutable image digest; takes precedence over `image.tag` |
| `image.imagePullPolicy` | `IfNotPresent` | Image pull policy |
| `startupProbe` | `/healthz` for up to 5 minutes | Allows migrations to finish before liveness checks |
| `readinessProbe` | `/healthz` | Removes unhealthy pods from Service endpoints |
| `ingress.enabled` | `true` | Creates an Ingress |
| `httpRoute.enabled` | `false` | Creates a Gateway API HTTPRoute without changing Ingress |
| `httpRoute.parentRefs` | `[]` | Required non-empty Gateway parent list when HTTPRoute is enabled |
| `httpRoute.backendRefs` | `[]` | Empty selects the chart Service; custom backends require a name and port |
| `httpRoute.hostnames` | `[]` | Optional hostnames matched by the route |
| `httpRoute.path` | `PathPrefix /` | HTTP path match; defaults to the root path |
| `podDisruptionBudget.enabled` | `false` | Creates an opt-in PDB for voluntary evictions |
| `podDisruptionBudget.minAvailable` | `null` | Minimum available; set exactly one availability field |
| `podDisruptionBudget.maxUnavailable` | `null` | Maximum unavailable; set exactly one availability field |
| `persistence.enabled` | `true` | Mounts persistent application data at `/wiki/data` |
| `persistence.existingClaim` | unset | Existing application-data PVC |
| `persistence.size` | `2Gi` | Application-data PVC request |
| `postgresql.enabled` | `true` | Creates the bundled PostgreSQL StatefulSet |
| `postgresql.existingSecret` | unset | Existing bundled-database credential Secret |
| `postgresql.postgresqlPassword` | unset | Required only when the chart creates the Secret |
| `postgresql.persistence.enabled` | `true` | Retains database data on a PVC |
| `postgresql.persistence.size` | `8Gi` | Database PVC request |
| `postgresql.podSecurityContext` | `{}` | Pod security context passed to the bundled PostgreSQL StatefulSet |
| `postgresql.securityContext` | `{}` | Container security context passed to bundled PostgreSQL |
| `externalPostgresql.existingSecret` | unset | External database password Secret |

See [`values.yaml`](values.yaml) for the complete set of supported values.

## Extra trusted certificates

Mount a PEM bundle and point `nodeExtraCaCerts` to it:

```yaml
nodeExtraCaCerts: /cas.pem
volumeMounts:
  - name: ca
    mountPath: /cas.pem
    subPath: certs.pem
volumes:
  - name: ca
    configMap:
      name: wiki-ca
```

The historical Wiki.js credits and license notices remain in the repository and corresponding source archive.
