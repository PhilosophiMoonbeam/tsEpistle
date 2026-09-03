# Docker Compose deployment

This directory defines one canonical tsEpistle application and PostgreSQL stack. Its project, volume, network, and proxy-alias names are configured independently from its public hostname, allowing DNS or reverse-proxy cutovers without renaming stateful Docker resources.

## Prepare the environment

Copy [`env.example`](./env.example) to `.env`, select a reviewed immutable image, and adjust the infrastructure names if needed:

```console
cp deploy/compose/env.example deploy/compose/.env
```

The `.env` file is intentionally ignored. Pass it explicitly so behavior does not depend on the shell's working directory:

```console
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml config
```

## Create runtime secrets

The default state directory is `/opt/tsepistle`. The app image runs as UID 1000, so app-mounted secret files must be readable by that UID. The database gets a separate root-owned copy of the same password.

```console
tsepistle_state_dir=/opt/tsepistle
tsepistle_key_id=primary-$(date -u +%Y%m%d)
install -d -m 700 "$tsepistle_state_dir"
umask 077

openssl rand -base64 48 | tr -d '\n' > "$tsepistle_state_dir/db-password"
install -o 1000 -g 1000 -m 400 "$tsepistle_state_dir/db-password" "$tsepistle_state_dir/app-db-password"

tsepistle_profile_key=$(openssl rand -base64 48 | tr -d '\n')
jq -n --arg id "$tsepistle_key_id" --arg key "$tsepistle_profile_key" \
  '{currentKeyId:$id,keys:{($id):$key}}' > "$tsepistle_state_dir/agent-profile-resolution-keys.json"

tsepistle_provider_key=$(openssl rand -base64 32 | tr -d '\n')
jq -n --arg id "$tsepistle_key_id" --arg key "$tsepistle_provider_key" \
  '{currentKeyId:$id,keys:{($id):$key}}' > "$tsepistle_state_dir/agent-provider-secret-keys.json"

openssl rand -base64 48 | tr -d '\n' > "$tsepistle_state_dir/agent-snapshot-signing-secret"
tsepistle_mcp_key=$(openssl rand -base64 48 | tr -d '\n')
printf 'AGENT_MCP_REQUEST_STATE_KEYS=["%s"]\n' "$tsepistle_mcp_key" > "$tsepistle_state_dir/agent-runtime.env"

chown 1000:1000 \
  "$tsepistle_state_dir/agent-profile-resolution-keys.json" \
  "$tsepistle_state_dir/agent-provider-secret-keys.json" \
  "$tsepistle_state_dir/agent-snapshot-signing-secret"
chmod 400 \
  "$tsepistle_state_dir/agent-profile-resolution-keys.json" \
  "$tsepistle_state_dir/agent-provider-secret-keys.json" \
  "$tsepistle_state_dir/agent-snapshot-signing-secret"
chmod 600 "$tsepistle_state_dir/db-password" "$tsepistle_state_dir/agent-runtime.env"
install -d -o 1000 -g 1000 -m 750 "$tsepistle_state_dir/data"
```

Back up the Agent key files securely. Losing or replacing them without a planned rotation can make stored provider credentials, profile-resolution tokens, or signed snapshots unusable.

## Start the stack

Create the internal network shared with the reverse proxy, attach that proxy, and start tsEpistle:

```console
set -a
. deploy/compose/.env
set +a
docker network create --internal "$TSEPISTLE_PROXY_NETWORK"
docker network connect "$TSEPISTLE_PROXY_NETWORK" your-caddy-container
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml up -d
```

Adapt [`Caddyfile.example`](./Caddyfile.example) to the desired hostname and proxy alias. The app has a separate egress network for configured Agent providers; its database and reverse-proxy networks remain internal.

## Wiki Agent

All Agent capabilities except browser automation are enabled by [`config.yml`](./config.yml). Browser automation requires a separately isolated worker and is intentionally absent from this stack.

Feature flags expose the runtime but do not grant access or select a model. Administrators inherit Agent access through `manage:system`. Other users need `use:agents`; MCP clients need a dedicated group with `use:mcp` and only the required page permissions. Configure and conform a model provider under **Administration → Wiki Agent → Providers**. Generate MCP API keys only after MCP is enabled so their tokens contain the required resource claim.

## Upgrades

Build release images only from clean, reviewed commits and identify them with immutable tags or digests:

```console
bun run docker:build local/tsepistle:<version>-<commit>
```

Back up PostgreSQL, `/wiki/data`, and the Agent keys together before replacing the image. Database migrations are forward-only; rollback means restoring the matching database and data snapshot rather than starting older code against a migrated database.
