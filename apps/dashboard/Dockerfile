# Build context must be the repo root: docker build -f apps/dashboard/Dockerfile .
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/dashboard apps/dashboard
ARG NEXT_PUBLIC_ACARD_API_URL
ENV NEXT_PUBLIC_ACARD_API_URL=${NEXT_PUBLIC_ACARD_API_URL}
WORKDIR /app/apps/dashboard
RUN npx next build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/dashboard/.next/standalone ./
COPY --from=build /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build /app/apps/dashboard/public ./apps/dashboard/public

EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
