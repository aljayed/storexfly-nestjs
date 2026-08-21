#!/usr/bin/env bash

# Create a validated, private PostgreSQL backup from the production container.
# The script intentionally reads credentials inside the container so secrets
# never appear in this file, cron, or the host process list.
set -euo pipefail

readonly backup_dir='/opt/storexfly/backups/postgres'
readonly container='storexfly_postgres'
readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly final_path="${backup_dir}/storexfly-${timestamp}.dump"
readonly temp_path="${final_path}.partial"

install -d -m 700 "${backup_dir}"
trap 'rm -f "${temp_path}"' EXIT

docker exec "${container}" sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "${temp_path}"

test -s "${temp_path}"
docker exec -i "${container}" pg_restore -l < "${temp_path}" >/dev/null

chmod 600 "${temp_path}"
mv "${temp_path}" "${final_path}"
sha256sum "${final_path}" > "${final_path}.sha256"
chmod 600 "${final_path}.sha256"
trap - EXIT

# Keep two weeks of daily backups. Restrict deletion to this dedicated folder
# and the exact filenames produced above.
find "${backup_dir}" -maxdepth 1 -type f \
  \( -name 'storexfly-*.dump' -o -name 'storexfly-*.dump.sha256' \) \
  -mtime +14 -delete

printf 'backup_ok path=%s size_bytes=%s\n' \
  "${final_path}" "$(stat -c %s "${final_path}")"
