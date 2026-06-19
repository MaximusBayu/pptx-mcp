FROM node:20-slim AS deps
WORKDIR /app
COPY web/package*.json ./
RUN npm ci

FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ .
RUN npx prisma generate && npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
