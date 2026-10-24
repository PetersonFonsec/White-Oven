#!/bin/sh
# Runs once, as the bootstrap superuser, when the official postgres image initializes an empty
# data directory. Creates the migration role and the application database; every other role and
# grant comes from the migrations (apps/api/src/database/migrations). The superuser is not used
# by the API or by migrations afterwards.
set -eu
: "${WHITEOVEN_OWNER_PASSWORD:?WHITEOVEN_OWNER_PASSWORD is required}"
: "${WHITEOVEN_DB_NAME:=whiteoven}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_password="$WHITEOVEN_OWNER_PASSWORD" -v db_name="$WHITEOVEN_DB_NAME" <<'SQL'
-- CREATEROLE lets migrations create the runtime roles; without SUPERUSER or BYPASSRLS the owner
-- cannot grant either. CREATEDB is for throwaway databases in integration tests.
create role whiteoven_owner login createrole createdb nosuperuser nobypassrls noreplication
  password :'owner_password';
create database :"db_name" owner whiteoven_owner;
SQL
