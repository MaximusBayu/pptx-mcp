#!/usr/bin/env bash
set -euo pipefail
BASE=${BASE:-http://localhost:3000}

echo "engine health"
curl -fsS http://localhost:8000/health

echo "register"
curl -fsS -X POST "$BASE/api/register" -d '{"email":"smoke@test.com","password":"password123"}'

echo "OK — full UI flow (upload/tag/render via key) requires an authenticated session; verify in browser or a later Playwright test."
