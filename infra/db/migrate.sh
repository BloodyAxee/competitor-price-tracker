#!/bin/sh
set -eu

: "${POSTGRES_HOST:=db}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

export PGPASSWORD="${POSTGRES_PASSWORD}"

psql_base() {
  psql \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "${POSTGRES_HOST}" \
    -p "${POSTGRES_PORT}" \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    "$@"
}

psql_base <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
SQL

found_migration=false

for migration in /migrations/[0-9][0-9][0-9]_*.sql; do
  if [ ! -f "${migration}" ]; then
    continue
  fi

  found_migration=true
  filename="$(basename "${migration}")"

  case "${filename}" in
    *[!a-zA-Z0-9_.-]*)
      echo "Invalid migration filename: ${filename}" >&2
      exit 1
      ;;
  esac

  checksum="$(sha256sum "${migration}" | cut -d ' ' -f 1)"
  existing_checksum="$(psql_base -Atc "SELECT checksum FROM schema_migrations WHERE version = '${filename}'")"

  if [ -n "${existing_checksum}" ]; then
    if [ "${existing_checksum}" != "${checksum}" ]; then
      echo "Checksum mismatch for applied migration: ${filename}" >&2
      exit 1
    fi
    echo "Already applied: ${filename}"
    continue
  fi

  echo "Applying: ${filename}"
  psql_base \
    -1 \
    -f "${migration}" \
    -c "INSERT INTO schema_migrations (version, checksum) VALUES ('${filename}', '${checksum}')"
done

if [ "${found_migration}" = false ]; then
  echo "No migration files found" >&2
  exit 1
fi

echo "Migrations are up to date"
