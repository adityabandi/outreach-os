# Outreach OS - all-in-one image (app + worker share the image)
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
COPY --from=build /app /app
USER app
EXPOSE 3100
# DATABASE_URL, SESSION_SECRET, WEBHOOK_SECRET_* come from the environment.
# Requires an external Postgres 16+ (run migrations/ on deploy).
CMD ["pnpm", "start"]
# Worker variant: docker run <image> pnpm worker
