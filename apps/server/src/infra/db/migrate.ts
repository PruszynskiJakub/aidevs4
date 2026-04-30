import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "./connection.ts";

migrate(db, { migrationsFolder: "./apps/server/src/infra/db/migrations" });
