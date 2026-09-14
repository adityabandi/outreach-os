# Deployment runbook

Outreach OS is platform-agnostic: a Node 22 runtime, a Postgres 16+ database,
and (optionally) a container host. No vendor-specific services are required.
The same artifacts run on a bare VM, a container platform, or locally.

## Topology

| Process  | Command            | Role                                             |
|----------|--------------------|--------------------------------------------------|
| app      | `pnpm start`       | Next.js server on port 3100, serves UI + webhooks |
| worker   | `pnpm worker`      | Queue worker: sends, webhook processing           |
| migrate  | `pnpm db:migrate`  | One-off: applies `migrations/` in order           |
| bootstrap| `pnpm db:bootstrap`| One-off, idempotent: first org/workspace/admin    |

App and worker share one Docker image; migrate/bootstrap run as one-off tasks
with the same image and different commands.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | - | Postgres connection for the **application role** (`outreach_app`). RLS policies bind to this role; never run the app as the superuser. |
| `SESSION_SECRET` | yes | - | HMAC secret for session cookies. Generate with `openssl rand -hex 32`. Production refuses weak placeholders (`change-me`, empty). |
| `PUBLIC_BASE_URL` | no | `http://localhost:3100` | Absolute base URL embedded in outbound email links (unsubscribe). Set to the public https URL. |
| `UNSUB_SECRET` | no | falls back to `SESSION_SECRET` | Dedicated HMAC secret for unsubscribe tokens. Rotate independently if desired. |
| `WEBHOOK_SECRET_<PROVIDER>` | per provider | - | Signature secret for inbound webhooks, one per provider, uppercased (`WEBHOOK_SECRET_REWARDFUL`, `WEBHOOK_SECRET_GMAIL`, ...). |
| `WEBHOOK_SECRET_DEV` | no | - | Fallback webhook secret for local development. Do not rely on it in production. |
| `WORKER_POLL_MS` | no | `3000` | Worker queue poll cadence. |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | no | - | Gmail adapter OAuth client. Unset = mock mailbox (dev). |
| `GMAIL_REFRESH_TOKEN_*` | no | - | Per-sender refresh token; the sender integration row's secret ref names the env var. |
| `SEED_DEMO` | no | - | `true` allows the destructive demo seed. Demo deployments only. |
| `SEED_DATABASE_URL` | no | localhost default | Connection used by `pnpm db:seed` (needs the migration role). |
| `BOOTSTRAP_*` | bootstrap only | see `.env.example` | First-deployment identity inputs. |

Migrations and bootstrap need the **migration role** (the database owner /
superuser), because they create roles, extensions and RLS policies. Everything
else uses `DATABASE_URL` with the application role.

## Fresh spin-up with Docker Compose

Prereqs: Docker with the compose plugin. Copy `.env.example` to `.env` and set
at least `SESSION_SECRET`.

```bash
# 1. clean production-mode deployment (NO demo data)
docker compose up -d

# 2. create the first admin (idempotent, safe to re-run)
BOOTSTRAP_ADMIN_EMAIL=you@company.com docker compose --profile init run --rm bootstrap

# 3. open http://localhost:3100 and sign in as that account
```

`docker compose up` starts db, runs migrations, then starts app + worker.
The app exposes `GET /api/health` (database ping) for liveness checks.

### Demo deployment (disposable)

```bash
docker compose --profile demo up -d
```

The `demo` profile additionally runs the seed, which **truncates all data**
and loads two fictional workspaces (Ayurveda Nest, Northwind Demo). The seed
is guarded in code as well: with `NODE_ENV=production` it refuses to run
unless `SEED_DEMO=true`. Nothing outside the demo profile sets that flag.

## Fresh spin-up without Docker

```bash
# Node 22+, pnpm, a running Postgres 16+
createdb outreach_os
DATABASE_URL=postgres://owner:pw@host:5432/outreach_os pnpm db:migrate
DATABASE_URL=postgres://owner:pw@host:5432/outreach_os \
  BOOTSTRAP_ADMIN_EMAIL=you@company.com pnpm db:bootstrap
pnpm build
DATABASE_URL=postgres://outreach_app:pw@host:5432/outreach_os \
  SESSION_SECRET=$(openssl rand -hex 32) \
  PUBLIC_BASE_URL=https://outreach.example.com \
  pnpm start            # process 1: app
DATABASE_URL=... SESSION_SECRET=... pnpm worker   # process 2: worker
```

## Upgrades

1. Deploy the new image/build.
2. Run `pnpm db:migrate` (idempotent; applies only new migrations).
3. Restart app and worker. Migrations are additive; the old app keeps working
   during the migration window.

## Operations notes

- **Backups**: plain `pg_dump` of the database covers all state; there is no
  other persistent state. The compose `pgdata` volume holds everything.
- **Secrets**: provide them via the environment of your platform; never bake
  them into the image. `.env` is git-ignored.
- **Real email sending**: unset Gmail vars keep the mock mailbox. Configure
  `GMAIL_CLIENT_ID/SECRET` and a per-sender refresh token to enable live sends.
- **Webhooks**: point providers at `POST /api/webhooks/<provider>` with the
  matching `WEBHOOK_SECRET_<PROVIDER>`; unsigned or mis-signed events are
  rejected and nothing is processed.
- **Kill switch**: the sidebar "Stop all" halts every send immediately without
  a deploy; "Resume" re-enables.
