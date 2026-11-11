import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pgliteMemoryStore } from "../lib/memory/local.js";
import { neonMemoryStore } from "../lib/memory/store.js";
import { configureDatabase, loadLocalEnv } from "../lib/local-config.js";
import { localApp } from "../lib/local-app.js";

try {
  loadLocalEnv();
  const mode = configureDatabase(process.argv.slice(2));
  const dir = process.env.MEMORY_DATA_DIR || ".memory-lane";
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  const initializeToken = () => {
    // Generate a local token only when the caller hasn't supplied one. Never send it to the Web UI.
    if (!process.env.MCP_TOKEN) {
      mkdirSync(dir, { recursive: true });
      const tokenFile = join(dir, "token");
      if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
      process.env.MCP_TOKEN = readFileSync(tokenFile, "utf8").trim();
    }
    if (process.env.MCP_TOKEN.length < 32) throw new Error("MCP_TOKEN must be at least 32 characters.");
  };
  // Preserve local startup behavior; Neon without a token waits until its database is ready.
  if (mode === "local" || process.env.MCP_TOKEN) initializeToken();
  const fixtures = process.env.MEMORY_FIXTURES === "1";
  if (mode === "local" && !fixtures) mkdirSync(dir, { recursive: true });
  const local = mode === "local" ? pgliteMemoryStore(fixtures ? undefined : join(dir, "pgdata")) : undefined;
  const store = local?.store ?? neonMemoryStore();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      store.core(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 10_000); }),
    ]);
  } catch {
    throw new Error("Database startup failed or timed out. Check the selected database configuration and connectivity. Startup may initialize its schema.");
  } finally { clearTimeout(timer); }
  if (mode === "neon" && !process.env.MCP_TOKEN) initializeToken();
  if (fixtures) {
    const { sampleMemories } = await import("./samples.js");
    await store.save(sampleMemories);
  }
  const app = localApp(store, port, mode);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 1_048_576) { outgoing.writeHead(413); outgoing.end("Request too large"); return; }
        chunks.push(Buffer.from(chunk));
      }
      const request = new Request(new URL(incoming.url ?? "/", `http://127.0.0.1:${port}`), {
        method: incoming.method, headers: incoming.headers as Record<string, string>,
        ...(!["GET", "HEAD"].includes(incoming.method ?? "GET") ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await app(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      outgoing.end(incoming.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end("Request failed"); }
  });
  server.on("error", () => { console.error("Local server failed to listen. Check PORT and other running servers."); process.exit(1); });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Memory Lane: http://127.0.0.1:${port}/memory`);
    console.log(mode === "neon" ? "Neon database: changes apply directly to the connected database." : `Local database (${fixtures ? "in-memory samples" : dir})`);
    console.log("MCP token: use MCP_TOKEN from your environment, or the token file in MEMORY_DATA_DIR (default .memory-lane/token).");
  });
  const shutdown = () => server.close(() => { void (local?.db.close() ?? Promise.resolve()).finally(() => process.exit(0)); });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (error) {
  // Only errors constructed here are shown; underlying database/network errors may contain credentials.
  console.error(error instanceof Error && /^(Usage:|Fixtures |Neon mode |PORT |MCP_TOKEN |Database startup)/.test(error.message) ? error.message : "Local startup failed. Check .env and local configuration.");
  process.exit(1);
}
