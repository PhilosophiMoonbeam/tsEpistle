# Scarlett REST/OpenAPI harvest backlog

> For Hermes: planning only. Do not execute these ports without explicit approval.

**Goal:** Build an evidence-backed backlog of REST/OpenAPI work from `origin/scarlett` that is realistically worth harvesting onto the current verified baseline branch.

**Architecture:** Use `origin/scarlett` as a mine, not a merge target. Prefer thin REST wrappers over existing baseline domain/model logic, plus reusable API-surface patterns, instead of porting Scarlett’s broader Fastify/multisite architecture wholesale.

**Tech Stack:** Current baseline = Express + GraphQL/Apollo + server models/resolvers. Scarlett = Fastify + OpenAPI/Swagger + selective REST migration.

---

## Current conclusions

1. Scarlett proves a real REST/OpenAPI direction, but it is incomplete and mixed.
2. The best harvest targets are not wholesale subsystems, but:
   - API infrastructure patterns
   - complete low-risk read/admin endpoints
   - thin REST wrappers over logic baseline already has
3. Do not attempt to port Scarlett’s multisite assumptions, incomplete users/pages APIs, or broad frontend REST migration as a first wave.

---

## Candidate buckets

### Ready-to-harvest

#### 1. REST/OpenAPI infrastructure pattern

**Source files on `origin/scarlett`:**
- `backend/index.js`
- `backend/api/index.js`

**What is valuable:**
- coherent domain-based REST route registration
- OpenAPI/Swagger exposure
- centralized JSON API error handling
- route-level metadata / permission annotation pattern

**Why it fits baseline:**
- baseline currently has only a few classic controllers under `server/controllers/*.js`
- this can be ported incrementally without replacing Express
- creates a stable shell for future REST consolidation

**Port mode:** manual semantic port

**Risk:** medium
- infrastructure touch, but self-contained if introduced as a new modular REST layer under current Express app

**Likely baseline targets:**
- `server/master.js`
- new REST route registration area, likely under `server/controllers/api/` or `server/api/`
- possible OpenAPI docs route and schema helpers

**Validation scope:**
- route registration smoke tests
- auth/permission middleware tests
- full `corepack yarn test`
- full `corepack yarn build`

---

#### 2. System/admin read endpoints

**Source files on `origin/scarlett`:**
- `backend/api/system.js`

**What is valuable:**
- `GET /system/info`
- `GET /system/flags`
- `POST /system/checkForUpdate`
- possibly `GET /system/instances` later

**Why it fits baseline:**
- current baseline already has equivalent underlying data in GraphQL resolvers and models
- useful for admin bootstrap and external automation
- low feature risk; mostly serialization and auth wrapping

**Port mode:** manual semantic port, near-ready

**Risk:** low to medium

**Likely baseline analogs to reuse:**
- `server/graph/resolvers/system.js`
- current config / scheduler / version-check logic
- `server/controllers/common.js` patterns for operational endpoints

**Validation scope:**
- focused controller tests for authorized/unauthorized responses
- data-shape tests for info/flags/check-for-update
- full test/build

---

#### 3. Locales REST endpoints

**Source files on `origin/scarlett`:**
- `backend/api/locales.js`

**What is valuable:**
- `GET /locales`
- `GET /locales/:code/strings`

**Why it fits baseline:**
- baseline already has localization data and GraphQL access patterns
- useful bootstrap target for gradual GraphQL reduction
- narrow, self-contained, low blast radius

**Port mode:** manual semantic port

**Risk:** low

**Likely baseline analogs to reuse:**
- `server/graph/resolvers/localization.js`
- `server/models/locales.js`

**Validation scope:**
- route tests for locale list and translation-string payloads
- unauthorized/public access expectations as applicable
- full test/build

---

### Partial but salvageable

#### 4. Authentication REST subset

**Source files on `origin/scarlett`:**
- `backend/api/authentication.js`

**What is valuable now:**
- `GET /sites/:siteId/auth/strategies`
- `PUT /sites/:siteId/auth/login`
- `PUT /sites/:siteId/auth/changePassword`

**Why it fits baseline:**
- baseline already has active strategy listing and login/change-password logic via GraphQL and models
- route layer is the real missing piece, not core domain behavior

**Why only partial:**
- Scarlett auth is not complete end-to-end REST
- passkey/TFA/register/logout/refresh coupling is mixed or incomplete
- Scarlett also assumes multisite pathing not present in baseline

**Port mode:** manual semantic port

**Risk:** medium
- auth is always sensitive
- but the subset above appears bounded and practical

**Likely baseline analogs to reuse:**
- `server/graph/resolvers/authentication.js`
- `server/models/users.js`
- `server/controllers/auth.js`
- existing `req.user` / auth middleware stack in `server/master.js`

**Do not bundle initially:**
- logout refresh-token redesign
- passkey/TFA/register REST rewrite
- full auth architecture replacement

**Validation scope:**
- login success/failure tests
- change-password tests
- strategy listing tests
- no-regression checks against current browser auth flows
- full test/build

---

#### 5. Authenticated user bootstrap probe (`whoami`-style)

**Source files on `origin/scarlett`:**
- `backend/api/users.js` (only the `whoami` idea, not the whole subsystem)

**What is valuable:**
- tiny REST endpoint returning authenticated status and current user summary

**Why it fits baseline:**
- good frontend bootstrap/session hydration endpoint
- very small slice with low implementation risk

**Why only partial:**
- most of Scarlett’s users API is placeholder / hello-world
- Scarlett’s own `whoami` payload is simplistic and should not be copied verbatim

**Port mode:** manual semantic port

**Risk:** low

**Likely baseline analogs to reuse:**
- `req.user`
- `server/graph/resolvers/user.js` profile behavior

**Validation scope:**
- authenticated/unauthenticated route tests
- payload redaction/safety checks
- full test/build

---

#### 6. Single-site bootstrap config endpoint pattern

**Source files on `origin/scarlett`:**
- `backend/api/sites.js`

**What is valuable:**
- the idea of a read-only site/bootstrap config REST response

**Why it fits baseline:**
- baseline is single-site, but still benefits from a compact public bootstrap/config payload
- could reduce some GraphQL reads for app initialization later

**Why only partial:**
- Scarlett’s sites API is deeply tied to multisite concepts
- create/update/delete semantics do not map directly to baseline

**Port mode:** manual semantic port of the idea only

**Risk:** medium

**Likely baseline analogs to reuse:**
- `server/graph/resolvers/site.js`
- `res.locals.siteConfig` in `server/master.js`

**Do not bundle initially:**
- multisite CRUD
- hostname-aware site resolution
- admin site management write flows

---

### Skip for now

#### 7. Pages REST subsystem

**Source files on `origin/scarlett`:**
- `backend/api/pages.js`

**Reason to skip:**
- handlers are scaffolding/stubs (`return []` style)
- no meaningful implementation to harvest
- baseline already has rich page logic; if REST page routes are desired they should be designed directly from baseline behavior, not copied from Scarlett stubs

**Port mode:** skip

---

#### 8. Users REST subsystem beyond `whoami`

**Source files on `origin/scarlett`:**
- `backend/api/users.js`

**Reason to skip:**
- CRUD routes are placeholders / hello-world
- not production-complete enough to justify porting

**Port mode:** skip

---

#### 9. Scarlett multisite management and site asset resource routing as-is

**Source files on `origin/scarlett`:**
- `backend/api/sites.js`
- `backend/controllers/site.js`

**Reason to skip as direct ports:**
- tied to Scarlett multisite storage/config assumptions
- baseline is single-site and would need a simplified redesign rather than direct transplant

**Port mode:** skip as-is; selectively adapt only if a single-site version becomes clearly valuable later

---

## Suggested execution order

### Wave 1: establish REST foundation without architectural overreach
1. REST/OpenAPI infrastructure shell on baseline
2. system/info + flags + check-for-update routes
3. locales routes

### Wave 2: add practical session/bootstrap endpoints
4. `whoami`-style endpoint
5. auth strategies/login/change-password subset

### Wave 3: optional read-only bootstrap simplification
6. single-site bootstrap/config endpoint

### Explicitly deferred
- page REST API replacement
- users CRUD REST replacement
- full auth REST rewrite
- full frontend Apollo removal
- direct Fastify migration

---

## Port mode summary

| Candidate | Port mode | Risk | Notes |
|---|---|---:|---|
| REST/OpenAPI infrastructure | manual semantic port | medium | new shell, not direct file copy |
| system endpoints | manual semantic port | low-medium | underlying data already exists |
| locales endpoints | manual semantic port | low | narrow and self-contained |
| auth subset | manual semantic port | medium | bounded subset only |
| whoami endpoint | manual semantic port | low | tiny and useful |
| single-site bootstrap config | manual semantic port | medium | adapt idea, not multisite code |
| pages subsystem | skip | — | Scarlett implementation incomplete |
| users CRUD subsystem | skip | — | Scarlett implementation incomplete |
| multisite site management as-is | skip | — | architecture mismatch |

---

## Recommendation

Do not continue with a generic “GraphQL modernization” lane as the next default.

Instead, the next approved campaign should be:

`API consolidation wave 1: REST foundation + low-risk admin/bootstrap endpoints`

That best aligns with:
- the user’s stated strategic direction
- Scarlett’s strongest reusable work
- the current verified baseline
- a low-risk, evidence-backed consolidation approach

---

## If approved, the next implementation plan should cover
- exact baseline file paths for a new REST route shell
- first-wave endpoints only:
  - system/info
  - system/flags
  - system/check-for-update
  - locales
  - whoami
- controller/service tests before code changes
- full verification and independent review before commit
