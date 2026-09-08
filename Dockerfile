FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY packages ./packages
COPY --chmod=755 deploy/entrypoint.sh /usr/local/bin/handoff-entrypoint
ENV NODE_ENV=production PORT=4003 LISTEN_HOST=0.0.0.0 DATA_DIR=/data
USER node
ENTRYPOINT ["/usr/local/bin/handoff-entrypoint"]
CMD ["node", "--import", "tsx", "src/server.ts"]

FROM docker:29-cli@sha256:eccaacfeed644c7de222ff047483568cb988dde95476fbaaf10ea2d04921bb66 AS docker-cli

FROM runtime AS preview-worker
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY deploy/worker-health.mjs /app/worker-health.mjs
USER node
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["src/processing-server.ts"]
