#!/usr/bin/env bash
# /opt/storexfly/deploy.sh — CI deploy entrypoint (invoked over SSH by GitHub Actions).
# Component-aware: build image, (backend) apply + VERIFY migrations, then health-check.
# Fails loudly (non-zero exit) on any problem so the GitHub Action goes red.
#
#   Usage: deploy.sh <backend|frontend|all>
set -euo pipefail

COMPONENT="${1:-all}"
COMPOSE_DIR="/opt/storexfly"
cd "$COMPOSE_DIR"

# Backend and frontend have separate CI workflows, but share this stack.
# Hold one host lock so their builds/restarts cannot overlap.
exec 9>"$COMPOSE_DIR/.deploy.lock"
flock -w 1200 9

# Postgres creds for the migration-count verification.
set -a; . "$COMPOSE_DIR/.env"; set +a
PGUSER="${POSTGRES_USER:-storexfly}"
PGDB="${POSTGRES_DB:-storexfly}"

ts()  { date -u +%H:%M:%S; }
log() { echo "[deploy $(ts)] $*"; }
die() { echo "[deploy $(ts)] ERROR: $*" >&2; exit 1; }

curl_code() {  # $1 = path — hits local nginx with the real Host header
  curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    -H 'Host: hoomri.com' "https://127.0.0.1${1}" 2>/dev/null || echo 000
}

wait_http() {  # $1 = path, $2 = label — retry up to ~60s for a 200
  local path="$1" label="$2" code=000
  for _ in $(seq 1 30); do
    code="$(curl_code "$path")"
    [ "$code" = "200" ] && { log "$label healthy (200)"; return 0; }
    sleep 2
  done
  die "$label did not return 200 within 60s (last=$code)"
}

verify_migrations() {
  # Guards against the historical "migration silently skipped but success printed" bug:
  # every .sql file must be reflected as an applied row.
  local files applied
  files="$(docker exec storexfly_api sh -c 'ls -1 dist/src/database/migrations/*.sql 2>/dev/null | wc -l' | tr -d '[:space:]')"
  applied="$(docker exec storexfly_postgres psql -U "$PGUSER" -d "$PGDB" -tAc \
      'SELECT count(*) FROM drizzle.__drizzle_migrations' 2>/dev/null | tr -d '[:space:]')"
  log "Migration files=$files  applied rows=$applied"
  [ -n "$files" ] && [ -n "$applied" ] || die "could not read migration counts"
  [ "$applied" -ge "$files" ] || die "migrations did not all land (files=$files > applied=$applied)"
  log "Migration verification passed."
}

deploy_backend() {
  log "Building api image ..."
  docker compose build api
  docker compose up -d postgres
  log "Backing up PostgreSQL ..."
  bash "$COMPOSE_DIR/backend/scripts/backup-db.sh"
  log "Applying DB migrations before starting the new API ..."
  docker compose run --rm --no-deps api node dist/src/database/migrate.js
  log "Starting api ..."
  docker compose up -d api
  verify_migrations
  wait_http "/api/health" "API"
}

deploy_frontend() {
  log "Building web image ..."
  docker compose build web
  log "Starting web ..."
  docker compose up -d web
  wait_http "/"           "Frontend"
  wait_http "/api/health" "API-via-web"
}

case "$COMPONENT" in
  backend)  deploy_backend ;;
  frontend) deploy_frontend ;;
  all)      deploy_backend; deploy_frontend ;;
  *) die "unknown component '$COMPONENT' (use: backend|frontend|all)" ;;
esac

log "Pruning dangling images ..."
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -af --filter "until=168h" >/dev/null 2>&1 || true
log "DEPLOY_OK ($COMPONENT)"
