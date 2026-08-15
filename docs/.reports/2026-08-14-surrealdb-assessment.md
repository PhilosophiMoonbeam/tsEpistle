# SurrealDB Assessment and PostgreSQL Decision

**Date:** 2026-08-14
**Status:** Decided
**Decision:** PostgreSQL remains the canonical database target for Wiki.js and its planned AI-native capabilities. SurrealDB is deferred.

## Executive decision

SurrealDB 3.x is technically well aligned with GraphRAG, hybrid lexical/vector retrieval, relation traversal, and agent memory. Its Business Source License permits normal use inside a hosted or distributed Wiki application, provided the application does not expose SurrealDB as a database service that lets third parties create, manage, or control database schemas or tables.

It is not a drop-in Wiki.js database backend. Wiki.js is deeply coupled to Knex, Objection, SQL migrations, relational identifiers, and direct SQL-backed services. Making SurrealDB canonical would require a persistence-layer replatform rather than a driver addition. The resulting implementation and operational risk is not justified before the AI-native product contracts have been established and measured.

PostgreSQL therefore remains the boring, supportable choice. AI features should initially use PostgreSQL-native full-text search, normalized relations or recursive CTEs, and the open-source `pgvector` extension where vector retrieval is required. Paid extensions or separate search services are not assumed.

## Scope clarification

The currently deployed local container was observed using SQLite 3.53.2. This decision identifies PostgreSQL as the intended production/canonical architecture; it does not itself migrate that deployment.

The System Info page's red compatibility warning is not evidence that SQLite is unsupported or that a migration has already occurred:

- the warning is rendered by a Vuetify 4 alert that still uses the legacy `:value` visibility binding;
- the server reports `Unknown Version` because it reads a removed `better-sqlite3` driver property instead of executing `SELECT sqlite_version()`.

Those are independent UI/reporting defects and should be fixed regardless of the database roadmap.

## License assessment

SurrealDB 3.0 is licensed under Business Source License 1.1. Its Additional Use Grant permits production use except as a **Database Service**, defined as an offering that uses SurrealDB to provide database functionality to third parties and enables those parties to create, manage, or control schemas or tables.

A conventional Wiki service stores application records on behalf of users; it does not give users arbitrary SurrealDB schema administration. That use is within the published grant. SurrealDB's licensing FAQ also states that applications may embed or run SurrealDB, may be shipped to customers, and may themselves be offered as a service.

Important boundaries:

- SurrealDB would remain separately BSL-licensed; it would not become AGPLv3.
- The Wiki application should communicate with a separately packaged SurrealDB process through the Apache-2.0 JavaScript SDK or a network API.
- A distribution containing SurrealDB must preserve and conspicuously display its BSL license.
- Arbitrary SurrealQL, table creation, schema management, and database credentials must not be exposed to tenants or agents.
- A future dynamic-schema feature that lets customers control actual SurrealDB tables would require written licensor confirmation or legal review.
- Each SurrealDB version is licensed separately and may have a different change date. License terms must be reviewed before upgrades.
- SurrealDB 3.0's stated change date is 2030-01-01, after which that licensed work changes to Apache License 2.0.

This is an engineering assessment, not legal advice.

## Technical fit

### Where SurrealDB is compelling

SurrealDB provides a coherent native model for:

- schemafull documents and flexible ingestion records;
- first-class relation records and bounded graph traversal;
- BM25 full-text indexes;
- HNSW and other vector indexes;
- hybrid lexical/vector result fusion;
- record- and field-level permissions;
- live queries and event-driven projections;
- page chunks, entities, citations, provenance, and agent memory in one query system.

These capabilities map naturally to an AI-native knowledge layer:

```text
lexical candidates
        +
semantic candidates
        +
authorized graph neighborhood
        |
        v
bounded fusion, reranking, and cited retrieval
```

### Why it is not currently suitable as Wiki.js's canonical store

The current persistence implementation is relational throughout:

- `server/core/db.ts` selects a SQL driver, initializes Knex, and binds all Objection models to it.
- Schema history is expressed through Knex migrations.
- The repository contains 22 model modules and 16 current migrations, plus historical beta and SQLite-specific migrations.
- Models depend on Objection relation mappings, graph fetching, SQL joins, generated numeric identifiers, JSON columns, and transaction behavior.
- Direct Knex access also supports rate limiting, health checks, asset binary storage, export streaming, telemetry, and migration/bootstrap behavior.
- PostgreSQL-specific `LISTEN/NOTIFY` supports multi-instance notifications.

SurrealDB has no Knex or Objection dialect. A proper cutover would have to replace model APIs, relation mappings, migrations, transaction boundaries, identifiers, pagination, health reporting, HA notifications, backup/restore procedures, and the existing multi-database integration suite.

A compatibility façade that pretends SurrealDB is Knex or Objection would retain the relational abstraction while hiding semantic mismatches. It should not be built.

## PostgreSQL implementation direction

PostgreSQL remains the system of record for:

- users, authentication, groups, and permissions;
- pages, history, comments, tags, and links;
- settings, modules, and audit-relevant state;
- AI source documents, provenance, and authorization metadata;
- durable indexing/outbox state.

Initial AI-native capabilities should prefer:

1. PostgreSQL built-in full-text search for lexical retrieval.
2. `pgvector` for embeddings and exact or approximate semantic retrieval.
3. Normalized relation tables for page links, entities, citations, and provenance.
4. Recursive CTEs for explicitly bounded graph expansion.
5. Application-owned reciprocal-rank fusion when lexical and semantic candidate sets must be combined.
6. Named, parameterized retrieval operations rather than arbitrary SQL tools for agents.
7. A final Wiki authorization check before any private content is returned to a model or user.

Every chunk or retrieval projection should retain:

- canonical page and page-version identifiers;
- locale and visibility state;
- source hash and source offsets;
- ACL or permission revision;
- embedding model, dimension, and chunking-strategy version;
- creation, invalidation, and reindex timestamps.

Vector search must not answer exact authorization, pricing, certification, compatibility, or lifecycle questions. Exact facts remain relational facts; semantic search identifies candidates only.

## Operational rationale

PostgreSQL is preferred now because it provides:

- direct compatibility with the existing Wiki.js persistence stack;
- mature backup, point-in-time recovery, replication, and observability tooling;
- broad managed-provider and self-hosting support;
- an OSI-approved permissive license;
- a large operational and hiring ecosystem;
- free full-text, relational, JSON, and vector capabilities;
- lower migration and rollback risk.

SurrealDB 3.x has reached general availability and is receiving stability and security hardening, but its production ecosystem, operational history, and upgrade experience remain younger. Vendor benchmarks and architectural elegance are useful evidence for a pilot, not sufficient evidence for replacing the canonical database.

## Conditions for revisiting SurrealDB

Reconsider SurrealDB only when one or more measured requirements cannot be met cleanly by PostgreSQL:

- bounded multi-hop graph retrieval becomes a demonstrated bottleneck;
- PostgreSQL lexical/vector fusion becomes operationally or computationally prohibitive;
- graph, vector, and document projections require enough independent infrastructure that SurrealDB would materially reduce the deployed system count;
- agent memory or real-time relation workloads cannot meet their latency and consistency contracts;
- a SurrealDB pilot proves backup, restore, upgrades, authorization, and performance against a production-shaped corpus;
- the project accepts a BSL runtime dependency as a deliberate governance decision.

A future evaluation must include:

- page create, update, move, delete, and history parity;
- group and page-rule authorization revocation with no stale AI disclosure;
- deterministic full rebuild from canonical source data;
- hybrid relevance evaluation against a fixed corpus;
- bounded graph traversal that cannot cross authorization boundaries;
- backup/export, clean restore, crash recovery, and patch-upgrade exercises;
- production-shaped latency, memory, disk, and index-build measurements;
- a clean migration and rollback plan;
- renewed license review for the exact selected version.

## Existing research reviewed

The assessment incorporated:

- `/home/bbferko/repos/Metitect/.research/SurrealDB_vs_PostgreSQL_for_GraphRAG.md`
- `/home/bbferko/repos/Metitect/.research/Aesthetic_Image_Search_with_SurrealDB.md`
- `/home/bbferko/repos/Metitect/.research/Metitect_SurrealDB_Database_Stack_Specification.md`

The later stack specification correctly recognizes that a SurrealDB transition is not a driver swap and identifies useful bounded-retrieval, provenance, schema, and migration contracts. The earlier comparison's conclusion that SurrealDB is unequivocally superior relies too heavily on vendor benchmarks and understates persistence migration, operational maturity, and rollback costs. Its query-shape ideas remain useful; its conclusion is not adopted for Wiki.js.

## References

- [SurrealDB 3.0 Business Source License](https://github.com/surrealdb/surrealdb/blob/main/LICENSE)
- [SurrealDB licensing FAQ](https://support.surrealdb.com/en/articles/11541883-frequently-asked-questions)
- [SurrealDB JavaScript SDK Apache-2.0 license](https://github.com/surrealdb/surrealdb.js/blob/main/LICENSE)
- [SurrealDB 3.0 release notes](https://surrealdb.com/releases/3.0)
- [SurrealDB 3.1 release notes](https://surrealdb.com/releases/3.1)
- [SurrealDB export documentation](https://surrealdb.com/docs/reference/cli/surrealdb-cli/commands/export)
