# Build context must be the repo root: docker build -f apps/api/Dockerfile .
# The API imports other workspaces (@acard/core, @acard/agent-wallet), so the whole repo goes in.
FROM node:22-slim
WORKDIR /repo
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
WORKDIR /repo/apps/api
USER node
CMD ["npx", "tsx", "src/index.ts"]
