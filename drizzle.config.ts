import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./apps/server/src/infra/db/schema.ts",
  out: "./apps/server/src/infra/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "./data/dev.db",
  },
});
