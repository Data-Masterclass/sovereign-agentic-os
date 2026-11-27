# PLATFORM-OWNED. Do not edit: the OS gate refuses an app whose Dockerfile differs from its template.
# Plain Docker: docker build -t app . && docker run -p 8080:8080 app
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts --no-audit --no-fund

# The database migrations (docs/rules/own-database.md): node-pg-migrate and pg from the platform-owned migrate/
# lockfile, plus the app's db/migrations/. Copied into the run image as /app/migrate; the platform runs them before
# every rollout with a fixed command (node /app/migrate/node_modules/node-pg-migrate/bin/node-pg-migrate.js up ...).
FROM node:22-alpine AS migrate
WORKDIR /app/migrate
COPY migrate/package.json migrate/package-lock.json migrate/NOTICE .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund --omit=dev
COPY db/migrations ./db/migrations

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=migrate /app/migrate ./migrate
USER 10001
EXPOSE 8080
CMD ["node", "server.js"]
