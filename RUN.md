# Running the Stack

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)
- Node.js 20+ (for the one-time Prisma migration step below)

---

## 1. Start Docker

Start Docker Desktop (or ensure the Docker daemon is running).

---

## 2. Copy and fill `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in the required secrets:

- `AUTH_SECRET` — generate a random string (e.g. `openssl rand -hex 32`)
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — optional; email/password login works without them
- `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` — optional; same as above
- `PPTX_API_KEY` — an API key you create in the web UI after first login

---

## 3. Generate the initial Prisma migration (first run only)

No migration files exist yet under `web/prisma/migrations/`. You must generate the initial migration
against a temporary Postgres instance before building the Docker stack.

Run these commands from the repo root:

```bash
# Spin up a temporary Postgres container
docker run -d --name pptx-pg-init \
  -e POSTGRES_USER=pptx \
  -e POSTGRES_PASSWORD=pptx \
  -e POSTGRES_DB=pptx \
  -p 5433:5432 \
  postgres:16

# Wait a few seconds for Postgres to be ready, then generate the migration
cd web
DATABASE_URL="postgresql://pptx:pptx@localhost:5433/pptx" \
  npx prisma migrate dev --name init
cd ..

# Stop and remove the temporary container
docker stop pptx-pg-init && docker rm pptx-pg-init
```

This creates `web/prisma/migrations/` which the production image needs for `prisma migrate deploy`.
Commit the generated migration files to source control.

---

## 4. Build and start the stack

```bash
docker compose build
docker compose up -d
```

Services:

| Service        | URL                          |
|----------------|------------------------------|
| web (Next.js)  | http://localhost:3000        |
| engine-service | http://localhost:8000        |
| MinIO console  | http://localhost:9001        |
| Postgres       | localhost:5432               |

---

## 5. Run the smoke test

```bash
bash scripts/e2e-smoke.sh
```

Expected output:
- `engine health` — `{"ok":true}`
- `register` — HTTP 201 with user JSON

For the full UI/agent flow there is now a Playwright suite. With the stack
running:

```bash
cd web
npx playwright install chromium   # first run only
npm run test:e2e                   # BASE_URL overridable (default http://localhost:3000)
```

It covers register → upload → tag → save → API key → render, plus the owner
test-render on the Use page.

---

## Production deployment

The local compose file is a dev convenience. For a real deployment:

### Secrets
- `AUTH_SECRET` — strong random (`openssl rand -hex 32`). Required.
- `DATABASE_URL` — managed Postgres connection string.
- OAuth (`AUTH_GOOGLE_*`, `AUTH_GITHUB_*`) — optional; email/password works without them.
- Never commit the real `.env`. It is gitignored.

### S3 / object storage and download URLs
Rendered decks are stored in S3-compatible storage and handed out as
**presigned URLs**. Two endpoints matter:

- `S3_ENDPOINT` — used by the web container to PUT/GET objects (internal,
  e.g. `http://minio:9000` in compose, or your private S3 endpoint).
- `S3_PUBLIC_ENDPOINT` — used **only to sign download URLs**. It must be
  reachable by whoever opens the link (the agent and/or a browser). The
  signature is computed over this host, so it cannot be string-swapped after
  the fact.

In production set `S3_PUBLIC_ENDPOINT` to a publicly reachable address:
- a real cloud bucket endpoint (S3, Cloudflare R2, etc.), or
- a public MinIO endpoint behind your domain (e.g. `https://files.example.com`).

If `S3_PUBLIC_ENDPOINT` is unset it falls back to `S3_ENDPOINT` — fine when
only in-network agents download, but host browsers won't be able to open the
links.

### Other
- Put the web service behind TLS; `trustHost: true` is already set for
  self-hosted/proxied deployments.
- `prisma migrate deploy` runs automatically on web container start; commit
  your migrations.

---

## Stopping the stack

```bash
docker compose down
```

To also remove volumes (wipes database and MinIO data):

```bash
docker compose down -v
```
