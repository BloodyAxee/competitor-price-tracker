import os
import sys

import psycopg


required_environment = (
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
)
missing_environment = [name for name in required_environment if not os.getenv(name)]

if missing_environment:
    raise RuntimeError(
        "Missing required database environment: " + ", ".join(missing_environment)
    )

with psycopg.connect(
    host=os.environ["POSTGRES_HOST"],
    port=int(os.environ["POSTGRES_PORT"]),
    dbname=os.environ["POSTGRES_DB"],
    user=os.environ["POSTGRES_USER"],
    password=os.environ["POSTGRES_PASSWORD"],
) as connection:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
                current_setting('server_version'),
                (SELECT count(*) FROM schema_migrations),
                (
                    SELECT count(*)
                    FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                ),
                (SELECT count(*) FROM app_settings)
            """
        )
        row = cursor.fetchone()

if row is None:
    raise RuntimeError("PostgreSQL returned no schema status")

server_version, migration_count, table_count, setting_count = row

if sys.version_info[:2] != (3, 13):
    raise RuntimeError(f"Expected Python 3.13, received {sys.version.split()[0]}")
if not server_version.startswith("18."):
    raise RuntimeError(f"Expected PostgreSQL 18, received {server_version}")
if migration_count < 7 or table_count < 12 or setting_count < 3:
    raise RuntimeError("The expected initial database schema is not available")

print(
    "Python database smoke test passed: "
    f"Python {sys.version.split()[0]}, PostgreSQL {server_version}, "
    f"{migration_count} migrations, {table_count} tables, {setting_count} settings."
)
