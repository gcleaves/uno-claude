# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: install everything and build the client bundle.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/
RUN npm ci

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: production dependencies only, resolved from the same lockfile.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/

# Only the root and the server workspace are needed at runtime; the client has
# already been compiled to static files in stage 1.
RUN npm ci --omit=dev --workspace server --include-workspace-root \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 3: the runtime image.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    UNO_SERVER_PORT=3001 \
    SNAPSHOT_PATH=/data/rooms.json

# Games are snapshotted here so a restart does not end them. Mount a volume at
# /data to make that survive the container itself, not just the process.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# `node` (uid 1000) ships with the base image; run as it rather than root.
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/client/dist  ./client/dist
COPY --chown=node:node package.json ./
COPY --chown=node:node server/ ./server/
COPY --chown=node:node shared/ ./shared/

USER node
EXPOSE 3001

# Compose and orchestrators use this to tell "listening" from "actually ready".
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.UNO_SERVER_PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Plain `node` with tsx registered as a loader, rather than an npm script: this
# keeps node as PID 1 so it receives SIGTERM directly for a clean shutdown.
CMD ["node", "--import", "tsx", "server/src/index.ts"]
