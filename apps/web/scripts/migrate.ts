import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("缺少 DATABASE_URL。请在 apps/web/.env.local 中配置后再执行迁移。");
  process.exit(1);
}

const client = postgres(databaseUrl, { max: 1, prepare: false });
const db = drizzle(client);
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

await migrate(db, { migrationsFolder });
await client.end();
console.log("migration applied");
