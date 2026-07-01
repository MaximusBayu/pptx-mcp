# DEPLOY.md — VPS deployment runbook (for an operator/agent)

Target: deploy pptx-mcp as a public HTTPS service on a single Linux VPS, so
agents call `https://app.<domain>/api/mcp/...` with an `x-api-key`. Includes
TLS, persistence, health checks, backups, updates, and rollback.

Execute steps **in order**. After each step run its **Verify** and do not
continue until it passes. Commands assume Ubuntu 22.04+ as root (or prefix
`sudo`). Replace `app.example.com` / `files.example.com` with real hosts.

---

## 0. Assumptions & DNS

- A fresh VPS (2 vCPU / 4 GB RAM / 20 GB disk minimum; LibreOffice rendering is
  memory-hungry).
- Two DNS **A records** pointing at the VPS public IP:
  - `app.example.com`  → web app / API
  - `files.example.com` → object storage (presigned download links)
- Ports 80 and 443 reachable from the internet.

**Verify:**
```bash
dig +short app.example.com files.example.com   # both must print the VPS IP
```

---

## 1. Install Docker + Compose plugin

```bash
curl -fsSL https://get.docker.com | sh
docker compose version
```
**Verify:** `docker compose version` prints v2.24 or newer (needed for the
`!reset` override tag used below). If older, upgrade Docker.

---

## 2. Firewall (defense in depth)

> NOTE: Docker's published ports bypass `ufw` via iptables. The real isolation
> comes from **not publishing** internal ports (done in step 5's override).
> `ufw` is a second layer.

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```
**Verify:** `ufw status` shows 22/80/443 allowed.

---

## 3. Get the code

```bash
mkdir -p /opt && cd /opt
git clone <YOUR_REPO_URL> pptx-mcp
cd /opt/pptx-mcp
```
**Verify:** `ls docker-compose.yml engine-service web mcp-server` lists all.

---

## 4. Create `.env` (secrets)

Generate strong secrets and write `.env`:

```bash
cd /opt/pptx-mcp
PG_PW=$(openssl rand -hex 24)
MINIO_USER="pptxminio"
MINIO_PW=$(openssl rand -hex 24)
AUTH_SECRET=$(openssl rand -hex 32)

cat > .env <<EOF
# --- auth ---
AUTH_SECRET=${AUTH_SECRET}
# Public origin of the web app (used by NextAuth):
NEXTAUTH_URL=https://app.example.com
AUTH_TRUST_HOST=true

# --- database ---
POSTGRES_USER=pptx
POSTGRES_PASSWORD=${PG_PW}
POSTGRES_DB=pptx
DATABASE_URL=postgresql://pptx:${PG_PW}@postgres:5432/pptx

# --- object storage (MinIO) ---
MINIO_ROOT_USER=${MINIO_USER}
MINIO_ROOT_PASSWORD=${MINIO_PW}
S3_BUCKET=pptx
S3_REGION=us-east-1
S3_ACCESS_KEY=${MINIO_USER}
S3_SECRET_KEY=${MINIO_PW}
# Internal endpoint (web -> minio over the compose network):
S3_ENDPOINT=http://minio:9000
# PUBLIC endpoint used to SIGN download URLs — must be reachable by agents:
S3_PUBLIC_ENDPOINT=https://files.example.com

# --- engine ---
ENGINE_URL=http://engine-service:8000
EOF
chmod 600 .env
```

> Cross-check the variable names against the app's real reads if a service
> fails to start (`docker compose logs web`). The names above match
> `web/src/lib/s3.ts`, `web/src/lib/auth.ts`, and `web/src/lib/engine.ts`; if a
> name differs, fix `.env` to match the code, not the other way around.

**Verify:** `grep -c '=' .env` ≥ 14, and `stat -c %a .env` → `600`.

---

## 5. Production compose override + Caddy

Create `compose.prod.yml` (adds restart policies, **named volumes for
persistence**, stops publishing internal ports, health checks, and a Caddy
reverse proxy that terminates TLS):

```bash
cat > compose.prod.yml <<'EOF'
services:
  postgres:
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    ports: !reset []
    volumes:
      - pgdata:/var/lib/postgresql/data

  minio:
    restart: unless-stopped
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    ports: !reset []
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD-SHELL", "curl -fs http://localhost:9000/minio/health/live || exit 1"]
      interval: 15s
      retries: 5

  createbucket:
    entrypoint: >
      /bin/sh -c "
      until /usr/bin/mc alias set m http://minio:9000 ${MINIO_ROOT_USER} ${MINIO_ROOT_PASSWORD}; do sleep 1; done;
      /usr/bin/mc mb -p m/${S3_BUCKET} || true;
      "

  engine-service:
    restart: unless-stopped
    ports: !reset []
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health',timeout=3).status==200 else 1)\""]
      interval: 15s
      timeout: 5s
      retries: 5

  web:
    restart: unless-stopped
    ports: !reset []
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://localhost:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval: 20s
      timeout: 5s
      retries: 5

  # The stdio MCP proxy is not needed for the HTTP service. Disable it in prod.
  mcp-server:
    deploy:
      replicas: 0

  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on: [web, minio]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  pgdata:
  miniodata:
  caddy_data:
  caddy_config:
EOF
```

Create the `Caddyfile` (automatic Let's Encrypt TLS):

```bash
cat > Caddyfile <<'EOF'
app.example.com {
    reverse_proxy web:3000
}

files.example.com {
    # Preserve Host so MinIO presigned-URL signatures validate.
    reverse_proxy minio:9000 {
        header_up Host {host}
    }
}
EOF
```

> Replace both hostnames with your real domains before continuing.

Define a stable compose alias for the rest of this runbook:

```bash
echo "alias dc='docker compose -f /opt/pptx-mcp/docker-compose.yml -f /opt/pptx-mcp/compose.prod.yml'" >> ~/.bashrc
source ~/.bashrc
```

**Verify:** `dc config >/dev/null && echo OK` prints `OK` (compose files parse;
confirms `!reset` is supported).

---

## 6. Generate the Prisma migration (first deploy only)

If `web/prisma/migrations/` already exists in the repo, **skip this step**.
Otherwise generate it once using a throwaway Postgres + a node container (no
host Node needed):

```bash
cd /opt/pptx-mcp
docker run -d --name pg-init -e POSTGRES_USER=pptx -e POSTGRES_PASSWORD=pptx \
  -e POSTGRES_DB=pptx -p 127.0.0.1:5433:5432 postgres:16
sleep 5
docker run --rm --network host -v "$PWD/web":/app -w /app node:20 \
  sh -c "npm ci && DATABASE_URL='postgresql://pptx:pptx@localhost:5433/pptx' npx prisma migrate dev --name init"
docker stop pg-init && docker rm pg-init
git add web/prisma/migrations && git commit -m "chore: initial prisma migration" || true
```
**Verify:** `ls web/prisma/migrations/*/migration.sql` exists.

---

## 7. Build & start

```bash
cd /opt/pptx-mcp
dc build
dc up -d
```
The `web` container runs `prisma migrate deploy` automatically on start.

**Verify (wait ~60s for TLS issuance + health):**
```bash
dc ps          # postgres/minio/engine-service/web/caddy = running/healthy
curl -fsS https://app.example.com/login >/dev/null && echo "web OK"
curl -fsS https://files.example.com/minio/health/live >/dev/null && echo "files OK"
```

---

## 8. Smoke test (prove the chain)

```bash
# 1) register a user (or do it in the browser)
curl -fsS -X POST https://app.example.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"ops@example.com","password":"changeme123"}' ; echo

# 2) in the browser at https://app.example.com :
#    log in -> New template -> upload a .pptx -> tag a slot -> Save
#    Settings -> API keys -> Create -> copy pk_...

# 3) with that key:
KEY=pk_xxx
curl -fsS https://app.example.com/api/mcp/templates -H "x-api-key: $KEY" ; echo
# -> lists your template(s); grab its id, then render:
curl -fsS -X POST https://app.example.com/api/mcp/templates/$TPL/render \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"deck_spec":{"slides":[{"slide_type":"slide_0","slots":{"title":"Hello"}}]}}'
# -> {"download_url":"https://files.example.com/...","validation":[],"warnings":[]}
```
**Verify:** the `download_url` opens and returns a valid `.pptx`
(`curl -fsS "<download_url>" -o /tmp/out.pptx && file /tmp/out.pptx`).

The service is now live. Below is ongoing operations.

---

## 9. Health checks (automated)

Container health is built in (step 5). Add an external watchdog that restarts
anything unhealthy and surfaces a non-zero exit for alerting.

```bash
cat > /opt/pptx-mcp/ops-healthcheck.sh <<'EOF'
#!/usr/bin/env bash
set -u
cd /opt/pptx-mcp
DC="docker compose -f docker-compose.yml -f compose.prod.yml"
fail=0

check() { # name url
  if ! curl -fsS --max-time 10 "$2" >/dev/null; then
    echo "$(date -Is) UNHEALTHY $1 ($2)"; fail=1
  fi
}
check web   https://app.example.com/login
check files https://files.example.com/minio/health/live

# Restart any container compose reports as unhealthy/exited.
bad=$($DC ps --format '{{.Service}} {{.Health}} {{.State}}' \
      | awk '$2=="unhealthy" || $3=="exited" {print $1}')
if [ -n "$bad" ]; then
  echo "$(date -Is) RESTARTING: $bad"
  $DC restart $bad
  fail=1
fi

exit $fail
EOF
chmod +x /opt/pptx-mcp/ops-healthcheck.sh

# run every 5 minutes, log to file
( crontab -l 2>/dev/null; \
  echo "*/5 * * * * /opt/pptx-mcp/ops-healthcheck.sh >> /var/log/pptx-health.log 2>&1" \
) | crontab -
```
**Verify:** `/opt/pptx-mcp/ops-healthcheck.sh; echo "exit=$?"` → `exit=0` while
healthy. Wire the exit/`echo` into your alerting (email, Slack webhook,
Uptime-Kuma, etc.).

Quick manual status anytime:
```bash
dc ps
dc logs --tail=100 web
dc logs --tail=100 engine-service
```

---

## 10. Backups

**Postgres (templates, users, API keys) + object storage — daily:**
```bash
cat > /opt/pptx-mcp/ops-backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/pptx-mcp
DC="docker compose -f docker-compose.yml -f compose.prod.yml"
OUT=/var/backups/pptx; mkdir -p "$OUT"
TS=$(date +%Y%m%d-%H%M%S)
# DB dump
$DC exec -T postgres pg_dump -U pptx pptx | gzip > "$OUT/db-$TS.sql.gz"
# Object storage (uploaded .pptx + outputs + previews)
docker run --rm --volumes-from "$($DC ps -q minio)" -v "$OUT":/backup alpine \
  tar czf "/backup/minio-$TS.tar.gz" /data
# Retain 14 days
find "$OUT" -name '*.gz' -mtime +14 -delete
echo "backup OK $TS"
EOF
chmod +x /opt/pptx-mcp/ops-backup.sh
( crontab -l 2>/dev/null; echo "30 3 * * * /opt/pptx-mcp/ops-backup.sh >> /var/log/pptx-backup.log 2>&1" ) | crontab -
```
**Verify:** run `/opt/pptx-mcp/ops-backup.sh` once → `ls -lh /var/backups/pptx`
shows a `db-*.sql.gz` and `minio-*.tar.gz`. Copy these off-box (rclone/scp) for
real durability.

**Restore (DB):**
```bash
gunzip -c /var/backups/pptx/db-YYYY...sql.gz | dc exec -T postgres psql -U pptx -d pptx
```

---

## 11. Update / redeploy flow

```bash
cd /opt/pptx-mcp
/opt/pptx-mcp/ops-backup.sh          # always back up before updating
git fetch && git checkout main && git pull
dc build
dc up -d                              # recreates changed services; web auto-runs
                                      # prisma migrate deploy on start
docker image prune -f
dc ps                                 # confirm healthy
curl -fsS https://app.example.com/login >/dev/null && echo "redeploy OK"
```
Zero-downtime is not configured (single host); expect a few seconds of blip on
`web`/`engine` recreate.

---

## 12. Rollback

```bash
cd /opt/pptx-mcp
git log --oneline -5                  # find the last-good commit
git checkout <good-sha>
dc build && dc up -d
```
If a **migration** is the problem, restore the DB dump taken in step 11 before
rolling the code back, then redeploy the older code.

---

## 13. Maintenance cheatsheet

| Task | Command |
|------|---------|
| Status / health | `dc ps` |
| Tail logs | `dc logs -f web` (or `engine-service`, `caddy`) |
| Restart one service | `dc restart web` |
| Full restart | `dc up -d` |
| Stop everything | `dc down` (keeps volumes/data) |
| Disk usage | `docker system df` ; `df -h` |
| Reclaim space | `docker image prune -f` (safe) ; **never** `down -v` in prod (wipes data) |
| Renew TLS | automatic (Caddy) — nothing to do |
| Rotate an API key | user deletes + recreates in **Settings → API keys** |
| Rotate AUTH_SECRET | edit `.env` → `dc up -d web` (logs out all sessions) |
| Rotate DB/MinIO creds | update `.env` consistently (DATABASE_URL + S3_* must match) → `dc up -d` |

---

## 14. Definition of done

- [ ] `dig` resolves both hosts to the VPS.
- [ ] `dc ps` shows postgres, minio, engine-service, web, caddy all up; web +
      engine-service **healthy**.
- [ ] `https://app.example.com/login` returns 200 over valid TLS.
- [ ] `https://files.example.com/minio/health/live` returns 200.
- [ ] Smoke test render returns a `download_url` that opens a real `.pptx`.
- [ ] Health-check cron installed (`crontab -l`).
- [ ] Backup cron installed; one backup pair exists in `/var/backups/pptx`.
- [ ] Internal ports (3000/8000/9000/5432) are **not** reachable from the public
      IP: `curl -m5 http://<VPS_IP>:3000` should fail/refuse.

---

## 15. Continuous Deployment (GitHub Actions → this VPS)

`.github/workflows/deploy.yml` auto-deploys on every push to **Max-dev**: it
runs the CI test suite (reusable `ci.yml`), and only if that passes, SSHes into
this box and runs the §11 update flow (`ops-backup.sh` → `git reset --hard
origin/Max-dev` → `dc build` → `dc up -d` → prune → health check).

### One-time server prep
- The repo at `${DEPLOY_PATH}` (default `/opt/pptx-mcp`) must be a git clone
  with an `origin` remote the deploy user can `git fetch`.
- `compose.prod.yml`, `Caddyfile`, and `.env` must already exist on the box
  (steps 4–5). CD never creates secrets; it only rebuilds/restarts.
- Create a deploy SSH keypair; put the **public** key in the deploy user's
  `~/.ssh/authorized_keys`. The **private** key goes in the `SSH_KEY` secret.
- The deploy user must be able to run `docker compose` (in the `docker` group).

### GitHub repo secrets (Settings → Secrets and variables → Actions)
| Secret | Required | Example | Purpose |
|--------|----------|---------|---------|
| `SSH_HOST` | yes | `203.0.113.10` or `app.example.com` | VPS host |
| `SSH_USER` | yes | `deploy` | SSH login user (in `docker` group) |
| `SSH_KEY` | yes | *private key PEM* | Deploy private key |
| `SSH_PORT` | no (def 22) | `22` | SSH port |
| `DEPLOY_PATH` | no (def `/opt/pptx-mcp`) | `/opt/pptx-mcp` | Repo path on the box |
| `SSH_KNOWN_HOSTS` | no | *`ssh-keyscan` output* | Pin host key; else auto-scanned |
| `DEPLOY_HEALTHCHECK_URL` | no | `https://app.example.com/login` | Post-deploy gate; job fails if unreachable |

Also create a GitHub **Environment** named `production` (Settings →
Environments) — the deploy job is bound to it, so you can add required
reviewers/approvals there if you want a manual gate before deploy.

### Manual deploy
Actions → **CD** → *Run workflow* (uses `workflow_dispatch`).

---

## Common failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `dc config` errors on `!reset` | Compose < 2.24 | upgrade Docker, or in `docker-compose.yml` bind ports to `127.0.0.1:` and drop the `!reset` lines |
| TLS won't issue | DNS not pointing at VPS, or 80/443 blocked | fix A records / firewall; `dc logs caddy` |
| `download_url` won't open | `S3_PUBLIC_ENDPOINT` not public, or Host not preserved | confirm `files.example.com` resolves + `header_up Host {host}` in Caddyfile |
| web crashes on boot | bad `DATABASE_URL` or missing migration | `dc logs web`; re-check `.env`; ensure step 6 ran |
| 401 on `/api/mcp/...` | wrong/disabled API key | recreate key in the UI; send header `x-api-key:` |
| render 500 / blank slides | engine-service down or OOM | `dc logs engine-service`; increase VPS RAM (LibreOffice) |
