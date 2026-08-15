# Wiki.ts Preview Helm chart

This chart deploys **Wiki.ts Preview 0.1.0-alpha.1**, an independent community fork derived from Wiki.js 2.5.314. It is not an official Wiki.js release.

- Source: <https://github.com/PhilosophiMoonbeam/wiki>
- License: [AGPL-3.0](../../LICENSE)
- Container: `ghcr.io/philosophimoonbeam/wiki:0.1.0-alpha.1`
- Support: <https://github.com/PhilosophiMoonbeam/wiki/issues>

The chart is preview software. Test upgrades and restores against a non-production copy before deployment.

## Prerequisites

- Kubernetes with a default `ReadWriteOnce` storage class, or an existing PVC
- Helm 3
- A PostgreSQL backup captured before every application or chart upgrade
- A Kubernetes Secret for database credentials

## Install

Package the chart from a tagged source checkout or download the chart archive from the matching GitHub release:

```console
helm package dev/helm
kubectl create secret generic wiki-postgresql \
  --from-literal=postgresql-username=postgres \
  --from-literal=postgresql-password='replace-with-a-strong-password'
helm install wiki ./wiki-ts-preview-0.1.0-alpha.1.tgz \
  --set postgresql.existingSecret=wiki-postgresql
```

The image tag defaults to the chart `appVersion`. Pin `image.tag` or, preferably, an immutable image digest through your deployment policy. Do not use `canary` or floating `preview` tags in production.

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
   helm template wiki ./wiki-ts-preview-0.1.0-alpha.1.tgz -f values.yaml > rendered.yaml
   ```

5. Upgrade with an explicit chart and values file:

   ```console
   helm upgrade wiki ./wiki-ts-preview-0.1.0-alpha.1.tgz -f values.yaml --atomic --timeout 15m
   ```

6. Confirm the Deployment is available, `/healthz` returns HTTP 200, login works, and a read/write page check succeeds.

Wiki.ts runs database migrations during startup. Do not run mixed application versions against one database during an upgrade.

## Rollback and restore

`helm rollback` restores Kubernetes resources, not database contents. If the new application has migrated the database, rolling back only the Deployment can start old code against a newer schema and is unsafe.

1. Stop all Wiki.ts pods.
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

The database PVC is intentionally retained. Delete it only after confirming that its data is no longer needed:

```console
kubectl delete pvc data-wiki-postgresql-0
```

## Important values

| Parameter | Default | Purpose |
| --- | --- | --- |
| `replicaCount` | `1` | Wiki.ts pod count |
| `revisionHistoryLimit` | `2` | Deployment revisions retained |
| `image.repository` | `ghcr.io/philosophimoonbeam/wiki` | Fork image repository |
| `image.tag` | chart `appVersion` | Application image tag |
| `image.imagePullPolicy` | `IfNotPresent` | Image pull policy |
| `startupProbe` | `/healthz` for up to 5 minutes | Allows migrations to finish before liveness checks |
| `readinessProbe` | `/healthz` | Removes unhealthy pods from Service endpoints |
| `ingress.enabled` | `true` | Creates an Ingress |
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
