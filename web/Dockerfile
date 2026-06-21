FROM node:22-slim AS deps
WORKDIR /app
COPY web/package*.json ./
# npm install (not ci): the lockfile is generated on Windows and omits some
# linux-only optional native deps (e.g. @emnapi), which makes strict `npm ci` fail.
RUN npm install --no-audit --no-fund

FROM node:22-slim AS build
WORKDIR /app
# Prisma needs OpenSSL at generate/runtime; node:22-slim doesn't ship it.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY web/ .
RUN npx prisma generate && npm run build

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app ./
ENV NODE_ENV=production
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
