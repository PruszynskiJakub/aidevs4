import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "./connection.ts";

migrate(db, { migrationsFolder: "./src/infra/db/migrations" });
