FROM node:24.22.3-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build && pnpm server:build

FROM node:24.22.3-bookworm-slim AS production-dependencies

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
RUN pnpm install --prod --filter @volt/server --frozen-lockfile

FROM node:24.22.3-bookworm-slim AS runtime

WORKDIR /app
RUN groupadd --system --gid 10001 volt \
  && useradd --system --uid 10001 --gid volt --home-dir /app --shell /usr/sbin/nologin volt \
  && mkdir -p /data \
  && chown volt:volt /data

COPY --from=production-dependencies --chown=volt:volt /app/node_modules/.pnpm ./node_modules/.pnpm
COPY --from=production-dependencies --chown=volt:volt /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=volt:volt /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=volt:volt /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=volt:volt /app/dist/volt ./dist/volt

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8080 \
  DATA_DIR=/data \
  WEB_DIST_DIR=/app/dist/volt/browser

USER volt:volt
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/auth/session').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "apps/server/dist/main.js"]
