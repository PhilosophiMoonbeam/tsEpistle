# tsEpistle Helm chart

This chart deploys **tsEpistle 0.1.0-alpha.1**, an independent community fork derived from Wiki.js 2.5.314. It is not an official Wiki.js release.

- Source: <https://github.com/PhilosophiMoonbeam/wiki>
- License: [AGPL-3.0](../../LICENSE)
- Container: `ghcr.io/philosophimoonbeam/wiki:0.1.0-alpha.1`
- Support: <https://github.com/PhilosophiMoonbeam/wiki/issues>

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
  -f values.yaml --atomic --wait --timeout 15m
```

If editing the values file is not possible, pass the equivalent override
explicitly on every upgrade:

```console
helm upgrade wiki ./tsepistle-0.1.0-alpha.1.tgz \
  -f values.yaml --set nameOverride=tsfranki \
  --atomic --wait --timeout 15m
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
2. Stop writes or schedule a maintenance window.
3. Create and verify a database backup. For bundled PostgreSQL, also snapshot the PVC if the storage provider supports consistent snapshots.
4. Render and inspect the new manifests:

   ```console
   helm lint dev/helm
   helm template wiki ./tsepistle-0.1.0-alpha.1.tgz -f values.yaml > rendered.yaml
   ```

5. Upgrade with an explicit chart and values file:

   ```console
   helm upgrade wiki ./tsepistle-0.1.0-alpha.1.tgz -f values.yaml --atomic --wait --timeout 15m
   ```

6. Confirm the Deployment is available, `/healthz` returns HTTP 200, login works, and a read/write page check succeeds.

tsEpistle runs database migrations during startup, so the Deployment intentionally uses the `Recreate` strategy to prevent old and new application versions from sharing one database during an upgrade. Kubernetes stops the old application pods before starting the new version; this avoids mixed-version operation at the cost of application downtime while the replacement pod migrates and becomes ready. Plan every upgrade as a maintenance window.

The Helm lifecycle CI installs the supported previous release from an explicit `repository:tag@sha256:digest` reference before upgrading to the candidate. The smoke gate refuses a missing, mutable, unresolved, or same-image previous release and records each distinct Docker image revision in its Helm revision values before testing upgrade and rollback. Keep this input pinned to an immutable application release that remains inside the supported upgrade window; never create the initial revision by retagging the candidate.

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

1. Stop all tsEpistle pods.
2. Restore the pre-upgrade database backup or volume snapshot.
3. Roll back the Helm release:

   ```console
   helm history wiki
   helm rollback wiki REVISION --wait --timeout 15m
   ```

4. Confirm `/healthz`, login, and read/write page behavior before reopening traffic.

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
| `persistence.enabled` | `true` | Mounts persistent application data at `/wiki/data` |
| `persistence.existingClaim` | unset | Existing application-data PVC |
| `persistence.size` | `2Gi` | Application-data PVC request |
| `postgresql.enabled` | `true` | Creates the bundled PostgreSQL StatefulSet |
| `postgresql.existingSecret` | unset | Existing bundled-database credential Secret |
| `postgresql.postgresqlPassword` | unset | Required only when the chart creates the Secret |
| `postgresql.persistence.enabled` | `true` | Retains database data on a PVC |
| `postgresql.persistence.size` | `8Gi` | Database PVC request |
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
