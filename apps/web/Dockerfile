# syntax=docker/dockerfile:1
# ── cre-command web image (Next.js standalone) ───────────────────────────────
# next.config.mjs sets output: 'standalone', so the runner copies the pruned
# server bundle (node_modules + apps/web/server.js) plus static assets.
# API_ORIGIN is baked into required-server-files.json at build time (rewrites
# are resolved then); inside compose it points at the api service.
ARG NODE_VERSION=22-alpine
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapters/package.json packages/adapters/
COPY packages/crawler/package.json packages/crawler/
COPY packages/api/package.json packages/api/
COPY packages/workers/package.json packages/workers/
COPY apps/web/package.json apps/web/
RUN npm ci --include=dev

FROM deps AS builder
ARG API_ORIGIN=http://api:4000
ENV API_ORIGIN=$API_ORIGIN \
    NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build -w apps/web

FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# No apps/web/public directory exists in this repo — nothing to copy.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(0)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
