\set ON_ERROR_STOP on

\if :{?target_url}
\else
\echo 'target_url is required, for example: -v target_url=https://wiki-canary.example.com'
DO $$ BEGIN RAISE EXCEPTION 'target_url is required'; END $$;
\endif

BEGIN;

UPDATE settings
SET value = json_build_object('v', :'target_url'),
    "updatedAt" = CURRENT_TIMESTAMP::text
WHERE key = 'host';

UPDATE settings
SET value = jsonb_set(COALESCE(value, '{}'::json)::jsonb, '{isEnabled}', 'false'::jsonb, true)::json,
    "updatedAt" = CURRENT_TIMESTAMP::text
WHERE key IN ('api', 'telemetry');

UPDATE settings
SET value = (COALESCE(value, '{}'::json)::jsonb || '{"host":"","user":"","pass":""}'::jsonb)::json,
    "updatedAt" = CURRENT_TIMESTAMP::text
WHERE key = 'mail';

UPDATE storage SET "isEnabled" = false;
UPDATE analytics SET "isEnabled" = false;
UPDATE loggers SET "isEnabled" = false;
UPDATE "commentProviders" SET "isEnabled" = false;
UPDATE authentication SET "isEnabled" = (key = 'local');
UPDATE "apiKeys" SET "isRevoked" = true;

COMMIT;
