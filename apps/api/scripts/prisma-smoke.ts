import { config as loadEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

loadEnv({ path: "../../.env", quiet: true });

const dockerDatabaseUrl = process.env.DATABASE_URL;

if (!dockerDatabaseUrl) {
  throw new Error("DATABASE_URL is required");
}

// The Compose hostname is correct inside containers. This check runs on the
// host, so it connects through the PostgreSQL port published by Compose.
const hostPort = process.env.POSTGRES_PORT ?? "5432";
const hostDatabaseUrl = dockerDatabaseUrl.replace(
  /@db:5432(?=\/)/,
  `@127.0.0.1:${hostPort}`,
);

if (hostDatabaseUrl === dockerDatabaseUrl) {
  throw new Error("DATABASE_URL must use the Compose database host 'db:5432'");
}

const adapter = new PrismaPg({ connectionString: hostDatabaseUrl });
const prisma = new PrismaClient({ adapter });

try {
  const rows = await prisma.$queryRaw<
    Array<{ serverVersion: string; migrationCount: bigint; tableCount: bigint }>
  >`
    SELECT
      current_setting('server_version') AS "serverVersion",
      (SELECT count(*)::bigint FROM schema_migrations) AS "migrationCount",
      (
        SELECT count(*)::bigint
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ) AS "tableCount"
  `;

  const status = rows[0];

  if (!status?.serverVersion.startsWith("18.")) {
    throw new Error(`Expected PostgreSQL 18, received ${status?.serverVersion ?? "unknown"}`);
  }

  if (status.migrationCount < 3n || status.tableCount < 11n) {
    throw new Error("The expected initial database schema is not available");
  }

  const settings = await prisma.appSetting.findMany({
    orderBy: { key: "asc" },
    select: { key: true },
  });

  if (settings.length < 3) {
    throw new Error(`Expected at least 3 application settings, received ${settings.length}`);
  }

  console.log(
    `Prisma smoke test passed: PostgreSQL ${status.serverVersion}, ${status.migrationCount} migrations, ${status.tableCount} tables, ${settings.length} settings.`,
  );
} finally {
  await prisma.$disconnect();
}
