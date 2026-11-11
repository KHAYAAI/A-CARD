# Build from the repository root:  fly deploy --config apps/sandbox/fly.toml --dockerfile apps/sandbox/Dockerfile .
FROM node:22-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci --ignore-scripts && node apps/sandbox/scripts/bundle.mjs

FROM node:22-slim
WORKDIR /app
COPY --from=build /repo/apps/sandbox/dist/ ./
ENV PORT=8080 ACARD_SANDBOX_PAGE=/app/index.html NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
