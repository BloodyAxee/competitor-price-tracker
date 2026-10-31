import { config as loadEnv } from "dotenv";

loadEnv({ path: "../../.env", quiet: true });

export function getDatabaseUrl(): string {
  const configuredUrl = process.env.DATABASE_URL;

  if (!configuredUrl) {
    throw new Error("DATABASE_URL is required");
  }

  if (process.env.DATABASE_HOST_MODE === "container") {
    return configuredUrl;
  }

  const hostPort = process.env.POSTGRES_PORT ?? "5432";
  return configuredUrl.replace(/@db:5432(?=\/)/, `@127.0.0.1:${hostPort}`);
}
