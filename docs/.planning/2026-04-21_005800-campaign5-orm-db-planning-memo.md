# Campaign 5: ORM and database modernization planning memo

> For Hermes: planning only. Do not execute migrations from this memo without explicit approval.

Goal: define a safe path for modernizing the current ORM / DB abstraction while preserving the project’s multi-database support.

Grounded current stack from repo inspection:
- `server/core/db.js`
  - uses `Knex`
  - uses `Objection.Model.knex(this.knex)`
  - dynamically selects `pg`, `mysql2`, `sqlite3`, `mssql`
  - uses custom `afterCreate` hooks for postgres/mysql
  - uses `pg-pubsub` for HA notifications on postgres only
- `server/master.js`
  - uses `connect-session-knex`
- models across `server/models/*.js`
  - heavily based on `objection`.Model
- resolvers and models include DB-specific branches for postgres/mysql/mariadb/sqlite
- migrations exist for regular and sqlite-specific paths under `server/db/`

---

## Modernization targets
- `knex` 0.21.7 -> 3.x
- `objection` 2.2.18 -> 3.x
- `connect-session-knex` 2.0.0 -> 5.x
- compatibility audit of migration and multi-DB assumptions

---

## Why this needs planning first
This is not a package hygiene problem. Current code contains:
- engine-specific query branches
- migration split by DB type
- session storage on Knex
- postgres-only pub/sub path for HA
- many model classes and resolver queries tied to legacy query-builder semantics

A careless bump here risks breaking one DB flavor while another still works.

---

## Grounded risk points

### 1. Centralized engine branching in `server/core/db.js`
Current code explicitly configures:
- `pg`
- `mysql2`
- `sqlite3`
- `mssql`

It also mutates connection config per engine and depends on hooks like:
- `set application_name`
- postgres `search_path`
- mysql `autocommit`
- mysql type casting behavior

Any Knex upgrade needs to validate these assumptions directly.

### 2. Widespread active use of Objection model classes
Many files under `server/models/` are plain `objection`.Model classes.
This implies high blast radius for changes in:
- model lifecycle behavior
- query API behavior
- relation handling and plugin assumptions

### 3. DB-specific logic exists in resolvers/models
Examples found:
- `server/graph/resolvers/page.js`
- `server/models/tags.js`
- migration helpers and beta migration path

This means the migration needs DB-matrix-aware test planning.

### 4. Session handling depends on Knex store behavior
Current code uses `connect-session-knex` in `server/master.js`.
That integration may need separate handling from the core Knex/Objection upgrade.

### 5. HA notifications depend on postgres-specific connection semantics
`server/core/db.js` uses `pg-pubsub` and `this.knex.client.connectionSettings`.
That path should be explicitly validated if Knex internals or connection shapes differ after upgrade.

---

## Questions this planning lane must answer

1. Which current Knex query patterns are incompatible with modern Knex?
2. Which Objection model patterns need adaptation for v3?
3. Can `connect-session-knex` be upgraded independently, or must it follow Knex migration?
4. What minimum local/CI DB matrix is required before touching this lane?
5. Does mssql remain actively supported enough to preserve in the first migration pass?

---

## Suggested discovery tasks for this memo

### Task 5.1: inventory DB engine assumptions
Files:
- `server/core/db.js`
- `server/master.js`
- `server/graph/resolvers/**/*.js`
- `server/models/**/*.js`

Deliverable:
- engine-specific behavior inventory

### Task 5.2: inventory model/query patterns likely to break
Files:
- `server/models/**/*.js`
- selected resolvers using query-builder chains

Deliverable:
- list of high-risk query idioms and model APIs

### Task 5.3: audit migration framework assumptions
Files:
- `server/db/`
- `server/db/migrator-source.js`
- sqlite-specific migration directories
- beta migration path

Deliverable:
- migration compatibility checklist

### Task 5.4: define DB matrix and rollback strategy
Deliverable:
- required validation matrix:
  - postgres
  - mysql
  - mariadb
  - sqlite
  - possibly mssql scope decision
- rollback strategy if one engine regresses

---

## Desired final deliverable of Campaign 5
A decision memo with:
- incompatibility inventory
- execution order recommendation
- required test coverage expansion
- DB matrix plan
- whether to upgrade session store in same lane or separate lane
- branch strategy and rollback plan

## Recommendation
Do not execute any ORM/DB upgrade until this memo exists and the DB matrix expectations are approved.