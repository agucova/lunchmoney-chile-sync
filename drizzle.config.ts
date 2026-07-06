import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/state/schema.ts",
  out: "./drizzle",
});
