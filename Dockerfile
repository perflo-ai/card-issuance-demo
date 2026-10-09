# Tiny, the demo partner, as one container for a host (live mode only: mock mode runs on this computer).
# The host sets PORT and terminates HTTPS in front; see README "Hosting".

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.base.json tsconfig.server.json tsconfig.web.json ./
COPY server ./server
COPY web ./web
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DEMO_DATA_FILE=/data/demo-store.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# The store holds access tokens. Attach a host volume at /data so a redeploy keeps it (Railway:
# Volumes, not a VOLUME line, which Railway refuses). The entrypoint gives /data to the
# unprivileged `node` user, because a host volume is mounted owned by root, and then runs as `node`.
RUN apk add --no-cache su-exec \
 && mkdir -p /data && chown node:node /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
