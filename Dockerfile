# syntax=docker/dockerfile:1
#
# obsidian-mcp-server as a container. Node runs the TypeScript sources directly (type stripping), so there is no
# build step. Runs as a non-root user and works with a read-only root filesystem: the only writable paths are the
# vault mount and /tmp. Pass the token as a file with MCP_TOKEN_FILE (see README).

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOME=/tmp \
    VAULT_ROOT=/vault \
    HOST=0.0.0.0 \
    PORT=3333
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# The default user in the node image (1000:1000). Override with `user:` so files in the vault keep their owner.
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/index.ts"]
