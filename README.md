# Outreach OS

Tenant-aware AI outreach operating system. Internal-first: one organization operates multiple isolated business workspaces; the same core becomes SaaS later without a rebuild.

**Hard boundary:** no campaign sends until an authorized approver approves one immutable, hash-locked campaign version (sender + exact audience + exact copy + timing + follow-up rules + caps). Replies are classified and drafted automatically, but never auto-sent.

## Stack

- Next.js 15 (App Router) + TypeScript + Tailwind
- Postgres 18 with row-level security (uuidv7 ids)
- Durable job queue in Postgres (`job_runs`, SKIP LOCKED worker)
- Provider adapters behind interfaces (`src/domain/adapters/`): the dev `mock-mailbox` (writes to the outbox table) and a real `gmail` adapter (OAuth refresh tokens live in env vars named by the integration row's secret ref, never in the database); `resolveMailboxAdapter` picks gmail when a healthy, fully-configured integration exists, otherwise mock. First model is the deterministic `mock-model`
- Vitest unit tests + a live service-level e2e script

## Run it

```bash
pnpm install
pnpm db:start          # starts embedded Postgres 18 on :5433 (userspace binaries, no sudo)
pnpm db:migrate        # applies migrations/
pnpm db:seed           # demo org: Ayurveda Nest + Northwind Demo workspaces
DATABASE_URL=postgres://outreach_app:outreach_app@localhost:5433/outreach_os pnpm dev
pnpm worker            # queue worker (separate process)
```

Sign in at `/login` with a seeded account (Aditya = org owner/approver, Lara = operator). Dev sign-in is session-cookie based; production swaps in managed OIDC behind the same `currentActor` interface.

### Docker

One image serves both processes; compose brings up Postgres, migrations, seed, app and worker:

```bash
docker compose up --build    # app on http://localhost:3100
```

`docker-compose.yml` runs Postgres 18, applies `migrations/` (which also create the non-superuser `outreach_app` role), seeds the demo org, then starts the app and worker. Point `DATABASE_URL` at any external Postgres 16+ and run `migrations/` on deploy for real environments.

```bash
pnpm test              # unit: state machine, canonical hashing, suppression/caps/windows
node --conditions=react-server --import tsx scripts/e2e.ts   # live e2e: approval, RLS, launch, send, pause
```

## Architecture

- `src/domain/` - pure rules: state machine, canonical payload + sha256 hashing, suppression/caps, tenancy/RBAC, audit redaction, provider adapter contracts
- `src/server/` - tenant-scoped services (campaigns, delivery, prospects); every command re-checks role + workspace, writes audit events
- `src/db/client.ts` - `withTenant()` sets the `app.workspace_id` GUC per transaction so RLS scopes every statement; the app connects as non-superuser `outreach_app` so policies bind
- `migrations/` - full schema + immutability trigger + RLS policies
- `src/queue/` + `src/worker/` - durable jobs with idempotency keys, retries, dead-letter

## Safety model (implemented + tested)

- Draft -> ready_for_review -> approval_pending -> approved -> scheduled -> running; terminal states never resume
- Approved versions are immutable at the database layer (trigger); launch recomputes the payload hash and refuses stale approvals
- Requester cannot approve their own version
- Senders verify by emailed 6-digit code (sha256 at rest, 24h expiry); campaigns refuse unverified/disabled senders at readiness AND immediately before each send
- Suppression checked at scheduling AND immediately before send; unsubscribe replies suppress before any AI runs
- Pause blocks every not-yet-sent delivery; workspace + org kill switches
- Caps (workspace/sender/per-domain) enforced transactionally; sends only inside the timezone window
- Idempotent: unique idempotency keys per recipient+version+step; re-processing never double-sends
- RLS proven: workspace B sees zero rows of workspace A (e2e check)

## Milestones (per spec)

Done in this pass: M0 skeleton, M1 tenancy/RBAC/RLS/audit, vertical slice of M2-M5 (CSV import, evidence, qualification display, sequence + campaign builder, approval flow, mock-mailbox sending with caps/suppression/pause, reply ingestion + classification + drafts, basic analytics).

Next: real mailbox adapter + webhooks, discovery adapters, AI personalization service (ModelAdapter is wired, currently the mock), dedupe review queue UI, conversion ingestion endpoints, retention, deployment config.
