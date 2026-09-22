import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

let database: Database | null = null;
let client: ReturnType<typeof postgres> | null = null;

export function getDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  return url && url.length > 0 ? url : null;
}

export function getDb() {
  const url = getDatabaseUrl();
  if (!url) {
    throw new Error("缺少 DATABASE_URL");
  }
  if (!database || !client) {
    client = postgres(url, {
      max: 1,
      // Supabase 事务池（6543）不支持 prepared statements。直连同样可用。
      prepare: false,
    });
    database = drizzle(client, { schema });
  }
  return database;
}

export async function closeDb() {
  if (client) {
    await client.end();
  }
  client = null;
  database = null;
}
