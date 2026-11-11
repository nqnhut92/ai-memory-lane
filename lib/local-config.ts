import { existsSync } from "node:fs";

export function loadLocalEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

export function databaseMode(args: string[]): "local" | "neon" {
  if (!args.length) return "local";
  const value = args.length === 2 && args[0] === "--db" ? args[1]
    : args.length === 1 && args[0].startsWith("--db=") ? args[0].slice(5) : undefined;
  if (value !== "local" && value !== "neon") throw new Error("Usage: npm start -- --db local|neon");
  return value;
}

export function configureDatabase(args: string[]): "local" | "neon" {
  const mode = databaseMode(args);
  if (mode === "local") delete process.env.MEMORY_DATABASE_URL;
  else {
    if (process.env.MEMORY_FIXTURES === "1") throw new Error("Fixtures cannot be used with Neon.");
    if (!process.env.MEMORY_DATABASE_URL) throw new Error("Neon mode requires MEMORY_DATABASE_URL.");
  }
  return mode;
}
