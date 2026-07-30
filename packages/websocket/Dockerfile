FROM node:20-alpine AS builder

WORKDIR /build

# Copy workspace manifests first for layer-caching
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/websocket/package.json ./packages/websocket/

RUN npm ci

# Copy source
COPY packages/core/ ./packages/core/
COPY packages/websocket/ ./packages/websocket/

# Build in dependency order
RUN npm run build -w @governance-connector-framework/core \
 && npm run build -w @governance-connector-framework/websocket

# ─── runtime image ───────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy workspace manifests
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/websocket/package.json ./packages/websocket/

# Production install only
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=builder /build/packages/core/dist ./packages/core/dist
COPY --from=builder /build/packages/websocket/dist ./packages/websocket/dist

ENV NODE_ENV=production

# Required at runtime (injected via env or secret):
#   REMOTE_CONNECTOR_WS_URL
#   OAUTH_TOKEN_URL
#   OAUTH_CLIENT_ID
#   OAUTH_CLIENT_SECRET

ENTRYPOINT ["node", "packages/websocket/dist/index.js"]
