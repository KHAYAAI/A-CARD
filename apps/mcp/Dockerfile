# Build context must be the repo root: docker build -f apps/mcp/Dockerfile .
# Runs the remote (Streamable HTTP) transport — apps/mcp/src/index-http.ts —
# not the stdio entrypoint, which only makes sense spawned locally by a
# desktop MCP client.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/mcp/package.json apps/mcp/package.json
RUN npm ci --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/mcp apps/mcp

EXPOSE 8788
WORKDIR /app/apps/mcp
CMD ["npx", "tsx", "src/index-http.ts"]
