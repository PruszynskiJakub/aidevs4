import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/infra/db/schema.ts",
  out: "./src/infra/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "./data/dev.db",
  },
});
