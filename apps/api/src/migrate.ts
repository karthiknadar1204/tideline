import { migrateDatabase } from "@tideline/db/migrate";

const databaseUrl = process.env.NEON_DB_URL;
if (!databaseUrl) {
  throw new Error("Set NEON_DB_URL to migrate Tideline's database.");
}

try {
  await migrateDatabase(databaseUrl);
  console.info("Tideline database migrations applied.");
} catch {
  console.error("Tideline could not migrate its database. Check NEON_DB_URL and database permissions.");
  process.exitCode = 1;
}
