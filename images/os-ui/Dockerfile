# Sovereign Agentic OS UI — multi-stage Next.js production build (standalone, non-root).
#
# Build context = the app dir (os-ui/), NOT images/os-ui/. From the repo root:
#   docker build -t sovereign-os/os-ui:0.1.0 -f images/os-ui/Dockerfile os-ui
#
# Node base pinned by tag (Alpine = small, ships a uid-1000 `node` user we drop to).

# ---- deps: install node_modules from the lockfile ----
FROM node:22.13.1-alpine3.21 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the standalone server ----
FROM node:22.13.1-alpine3.21 AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: minimal runtime, non-root ----
FROM node:22.13.1-alpine3.21 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# `output: 'standalone'` emits a self-contained server + only the traced deps.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Drop to the built-in non-root `node` user (uid 1000).
USER node

EXPOSE 3000
CMD ["node", "server.js"]
