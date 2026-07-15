# Build context must be the repo root: docker build -f apps/api/Dockerfile .
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/api apps/api

EXPOSE 8787
WORKDIR /app/apps/api
CMD ["npx", "tsx", "src/index.ts"]
