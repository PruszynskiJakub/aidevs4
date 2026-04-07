import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../../config/index.ts";
import * as schema from "./schema.ts";

mkdirSync(dirname(config.database.url), { recursive: true });

const sqlite = new Database(config.database.url);
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { sqlite };
