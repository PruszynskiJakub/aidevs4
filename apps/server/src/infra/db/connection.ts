import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../../config/index.ts";
import * as schema from "./schema.ts";

// Sync mkdir at module load — DB must exist before SQLite opens.
// Uses raw fs intentionally: this is infra-level init, not sandboxed.
mkdirSync(dirname(config.database.url), { recursive: true });

const sqlite = new Database(config.database.url);
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");
sqlite.run("PRAGMA synchronous = NORMAL");
sqlite.run("PRAGMA busy_timeout = 5000");

export const db = drizzle(sqlite, { schema });
export { sqlite };
