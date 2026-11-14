import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function migrateDatabase(databaseUrl: string) {
  const connection = postgres(databaseUrl, { max: 1 });
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

  try {
    await migrate(drizzle(connection), { migrationsFolder });
  } finally {
    await connection.end();
  }
}
