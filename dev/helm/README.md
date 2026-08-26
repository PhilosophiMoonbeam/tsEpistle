# tsFranki Helm chart

This chart deploys **tsFranki 0.1.0-alpha.1**, an independent community fork derived from Wiki.js 2.5.314. It is not an official Wiki.js release.

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
helm install wiki ./tsfranki-0.1.0-alpha.1.tgz \
  --set postgresql.existingSecret=wiki-postgresql
```

The image tag defaults to the chart `appVersion`. Prefer an immutable platform or multi-platform digest in `image.digest`; it takes precedence over `image.tag`. Do not use `canary` or floating `preview` tags in production.

Each pod receives its Kubernetes pod name as `INSTANCE_ID`. Lease ownership and cross-instance notifications therefore identify the exact process that handled the work; do not override this variable with a value shared by multiple replicas.

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

1. Record the current chart version, values, image digest, and database server version.
2. Stop writes or schedule a maintenance window.
3. Create and verify a database backup. For bundled PostgreSQL, also snapshot the PVC if the storage provider supports consistent snapshots.
4. Render and inspect the new manifests:

   ```console
   helm lint dev/helm
   helm template wiki ./tsfranki-0.1.0-alpha.1.tgz -f values.yaml > rendered.yaml
   ```

5. Upgrade with an explicit chart and values file:

   ```console
   helm upgrade wiki ./tsfranki-0.1.0-alpha.1.tgz -f values.yaml --atomic --wait --timeout 15m
   ```

6. Confirm the Deployment is available, `/healthz` returns HTTP 200, login works, and a read/write page check succeeds.

tsFranki runs database migrations during startup. Do not run mixed application versions against one database during an upgrade.

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

1. Stop all tsFranki pods.
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
| `replicaCount` | `1` | tsFranki pod count |
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
