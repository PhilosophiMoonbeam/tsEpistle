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

Use [`upgrade.sh`](./upgrade.sh) for prebuilt-only app redeployments. The VPS never builds images, compiles, installs dependencies, or launches a verification browser. Produce and qualify the image off-box, publish it to the configured registry, and select its immutable `REPOSITORY@sha256:DIGEST` reference. Normal beta candidates follow the fast plus risk-selected development checks; official-release qualification is a separate requirement, not inferred from deployment acceptance.

The clean deployment-tool checkout's `HEAD` is the **operator revision**, recorded independently from the full 40-character **application revision** (`APP_SHA`). Both the live and target application's Git commit objects must already exist locally; the tool never fetches or checks out source. Migration filenames, deployment contracts, package version, and the live-to-target risk diff come from the application commit, not from arbitrary operator `HEAD`. Keep the operator checkout unchanged until acceptance.

Create the root-owned operator profile once, outside the repository:

```console
install -m 600 deploy/compose/upgrade-profile.example.json /opt/tsepistle/upgrade-profile.json
$EDITOR /opt/tsepistle/upgrade-profile.json
```

Deployments have three steps: **plan → apply → accept**. Create the root-owned profile outside the repository. Its `imageRepository` must exactly match the selected image's repository. Registry credentials remain in the existing remote root Docker credential store; never put them in a profile, command argument, or plan.

### Off-box orchestration

From a clean off-box checkout at the same operator revision as the remote deployment-tool checkout:

```console
bash deploy/compose/upgrade-remote.sh \
  --host your-reviewed-ssh-host \
  --repository /path/to/tsEpistle \
  --profile /opt/tsepistle/upgrade-profile.json \
  --revision "$APP_SHA" \
  --image "$IMMUTABLE_IMAGE"
```

Provision trusted SSH host keys, SSH authentication, noninteractive `sudo`, registry login, Bun **1.4.3**, and the repository's locked dependencies and Chromium **before** deployment. The off-box runner uses Bun with automatic dotenv loading disabled and requires the installed `@playwright/test` version to match the exact package pin and an existing Chromium executable; it never installs dependencies or downloads browsers. The smoke launches the Playwright library, not its Node-only CLI; Bun and browsers remain off-box, never installed on the VPS. SSH uses `BatchMode=yes`, `StrictHostKeyChecking=yes`, no TTY, and no agent/port forwarding. Remote paths are safely quoted, including whitespace and quotes. SSH aliases/options such as ports or jump hosts belong in the operator's existing SSH configuration.

The runner pulls the immutable image remotely using existing registry authentication, requests safe JSON plan output, checks the operator/application/image bindings, and invokes the same upgrader's `apply`. It then runs the actual [`login-smoke.cjs`](./login-smoke.cjs) locally against the planned public URL. Only a successful browser process permits remote `accept` of that exact plan. Browser failure exits nonzero and leaves the applied app explicitly unaccepted; it does not restore an old image.

### Manual lifecycle

Pull before planning, using the same root Docker authentication context as the upgrader:

```console
sudo docker image pull -- "$IMMUTABLE_IMAGE"
sudo bash deploy/compose/upgrade.sh plan \
  --profile /opt/tsepistle/upgrade-profile.json \
  --revision "$APP_SHA" \
  --image "$IMMUTABLE_IMAGE"
```

Planning inventories the live image, migration ledger, app runtime contract, and protected containers without changing services. It validates the locally present candidate's repository digest, complete OCI revision and source labels, Linux architecture (including its application architecture label), and image ID. Missing/wrong images fail closed; neither host-Bun nor Dockerized-Bun build fallbacks exist.

Review the private expiring plan and run the printed `apply --plan PATH --confirm SHA256` command. Apply revalidates bindings, rehearses and captures recovery when required, replaces only the app with `--no-build --pull never`, and checks health plus data/config/container continuity. It never recreates PostgreSQL, runs `compose down`, prunes volumes, or touches the control Wiki.js stack.

The immutable mode-0600 plan remains unchanged, preserving its confirmation digest. Its mode-0600 `PLAN.state.json` companion records `applying`, then **`awaiting-external-browser-verification`** with the applied container/image IDs, start time, database and protected-container state, environment/config/secret fingerprints, migration ledger, and recovery location. An attempted plan cannot be reapplied. A fresh apply never claims acceptance.

Run the browser smoke on the provisioned off-box repository, then explicitly acknowledge its success:

```console
TSEPISTLE_SMOKE_URL=https://canary.example.com bun --no-env-file deploy/compose/login-smoke.cjs
# Only after the command above succeeds:
sudo bash deploy/compose/upgrade.sh accept \
  --plan /opt/tsepistle/upgrade-runs/PLAN.json \
  --confirm PLAN_SHA256 \
  --browser-smoke-passed
```

The last command runs on the VPS, not the browser host. `--browser-smoke-passed` is trusted operator confirmation, like `--confirm`; it does not run or simulate a browser. Prefer the off-box runner to enforce the success-to-accept sequence. Acceptance rechecks the original plan/operator/profile bindings, expiration, candidate identity/start time/health, DB identity/ledger, protected containers, and configuration/secrets before recording `accepted`. Changed/replaced/stale candidates fail closed. Complete browser verification and acceptance within `planLifetimeSeconds`; expiration is not an authorization bypass.

For automation, `plan ... --json` emits one secret-free JSON object on stdout (errors remain on stderr):

```json
{"schemaVersion":1,"plan":"/opt/tsepistle/upgrade-runs/PLAN.json","confirm":"PLAN_SHA256","operatorRevision":"OPERATOR_SHA","targetRevision":"APP_SHA","candidateImage":"REPOSITORY@sha256:DIGEST","candidateImageId":"sha256:IMAGE_ID","publicUrl":"https://canary.example.com"}
```

Do not scrape human-readable output or read/copy registry credentials. Plans, state, and recovery points are private operational state, not release qualification artifacts.

Routine code-only changes do not create a database backup. A new migration must have reviewed metadata in [`server/db/migration-deployment-contracts.json`](../../server/db/migration-deployment-contracts.json) **at the application commit**. When that contract marks persistent-state risk, apply additionally gates public traffic, drains writers, rehearses the migration against a disposable database clone, and captures a paired PostgreSQL plus complete `/wiki/data` recovery point before replacement. Unknown migration, storage, key, or topology risk stops rather than guessing.

If apply fails before replacement begins, it restarts the unchanged app. Once candidate creation has begun, it does not automatically start the old image: inspect the reported state first. If a migration committed, rollback is fix-forward or an explicitly authorized restore of the matching database and data recovery point—never simply starting old code. Browser rejection likewise never triggers automatic rollback.

The login browser check is an operational smoke test, not a replacement for change-specific CI. Run the relevant tests before creating a deployment plan. Focused local contract verification is `bun run test server/test/scripts/compose-upgrade.test.ts`; native end-to-end verification additionally requires an isolated real Compose deployment, registry candidate, root profile, verified SSH access, and the off-box pinned browser installation. Never exercise failure/replacement scenarios against the maintained VPS.
