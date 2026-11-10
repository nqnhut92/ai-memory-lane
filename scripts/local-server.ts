import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pgliteMemoryStore } from "../lib/memory/local.js";
import { handleMcp } from "../api/mcp.js";
import { handleMemory } from "../api/memory.js";

// Memory Lane on your own machine: an embedded PostgreSQL (PGlite) in .memory-lane/, nothing to sign up for.
// MEMORY_FIXTURES=1 keeps everything in memory with sample data instead (for trying it out; it resets on restart).
const dir = process.env.MEMORY_DATA_DIR || ".memory-lane";
const port = Number(process.env.PORT) || 4173;
mkdirSync(dir, { recursive: true });

// MCP_TOKEN from the environment, else one generated on the first run and kept next to the data.
const tokenFile = join(dir, "token");
if (!process.env.MCP_TOKEN) {
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  process.env.MCP_TOKEN = readFileSync(tokenFile, "utf8").trim();
}

const fixtures = process.env.MEMORY_FIXTURES === "1";
const { store } = pgliteMemoryStore(fixtures ? undefined : join(dir, "pgdata"));
if (fixtures) {
  const { sampleMemories } = await import("./samples.js");
  await store.save(sampleMemories);
}

// Only this machine may talk to the server. Checking Host as well stops a web page from reaching it through a DNS
// name that points at 127.0.0.1 (DNS rebinding).
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

createServer(async (incoming, outgoing) => {
  try {
    if (!hosts.has(incoming.headers.host ?? "")) { outgoing.writeHead(403); outgoing.end("Forbidden"); return; }
    const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new Request(url, {
      method: incoming.method, headers: incoming.headers as Record<string, string>,
      ...(!["GET", "HEAD"].includes(incoming.method ?? "GET") ? { body: Buffer.concat(chunks) } : {}),
    });
    let response: Response;
    if (["/mcp", "/api/mcp"].includes(url.pathname)) response = await handleMcp(request, store);
    else if (["/memory/api", "/api/memory"].includes(url.pathname)) response = await handleMemory(request, store);
    else response = new Response("Memory Lane: connect an MCP client to /mcp.\n", { status: url.pathname === "/" ? 200 : 404 });
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500); outgoing.end("Request failed"); }
}).listen(port, "127.0.0.1", () => {
  console.log(`Memory Lane: http://127.0.0.1:${port}/mcp  (data: ${fixtures ? "in memory, sample memories" : dir})`);
  console.log(`MCP token: ${process.env.MCP_TOKEN}`);
});
