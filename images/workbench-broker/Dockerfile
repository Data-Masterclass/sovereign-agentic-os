# Sovereign Agentic OS — Workbench Broker (node + http-proxy + @kubernetes/client-node).
# Non-root, minimal. Holds the ONLY (tightly-scoped) k8s credential in the path:
# it reconciles per-builder code-server Deployments/PVCs/Services/NetworkPolicies/
# Secrets in the WORKBENCH namespace ONLY, and reverse-proxies the browser to them.
FROM node:22.13.1-alpine3.21 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22.13.1-alpine3.21 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
USER node
EXPOSE 8080
CMD ["node", "server.js"]
