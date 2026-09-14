# Outreach OS - all-in-one image (app + worker share the image).
# Platform-agnostic: any Postgres 16+ and any container host work.
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && addgroup -S app && adduser -S app -G app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/.next ./.next
COPY next.config.ts ./
COPY src ./src
COPY migrations ./migrations
USER app
EXPOSE 3100
# Runtime configuration comes from the environment (see docs/deployment.md):
# DATABASE_URL and SESSION_SECRET are required; PUBLIC_BASE_URL, UNSUB_SECRET,
# WEBHOOK_SECRET_<PROVIDER>, GMAIL_* are optional per feature.
# Liveness: GET /api/health (db ping).
CMD ["pnpm", "start"]
# Worker variant:  docker run <image> pnpm worker
# Migrate variant: docker run <image> pnpm db:migrate
# Bootstrap:       docker run -e BOOTSTRAP_ADMIN_EMAIL=you@co.com <image> pnpm db:bootstrap
