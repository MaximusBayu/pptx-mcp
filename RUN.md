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

Full UI flows (upload, tag, render, MCP key) require an authenticated browser session; verify manually or add a Playwright suite later.

---

## Stopping the stack

```bash
docker compose down
```

To also remove volumes (wipes database and MinIO data):

```bash
docker compose down -v
```
