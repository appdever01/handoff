FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY packages ./packages
COPY --chmod=755 deploy/railway/entrypoint.sh /usr/local/bin/handoff-railway-entrypoint
ENV NODE_ENV=production DATA_DIR=/data LISTEN_HOST=::
USER root
ENTRYPOINT ["/usr/local/bin/handoff-railway-entrypoint"]
CMD ["node", "--import", "tsx", "src/server.ts"]
