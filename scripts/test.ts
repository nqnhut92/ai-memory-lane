// Memory Lane against a real PostgreSQL engine (PGlite with pg_trgm), no network.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pgliteMemoryStore } from "../lib/memory/local.js";
import { handleMcp } from "../api/mcp.js";
import { handleMemory } from "../api/memory.js";

const token = "t".repeat(40);
process.env.MCP_TOKEN = token;
delete process.env.MEMORY_DATABASE_URL;
const { store } = pgliteMemoryStore();
const bearer = { Authorization: `Bearer ${token}` };

// Write-time guardrails: duplicates, near duplicates, secrets, language.
const [saved, duplicate] = await store.save([{ content: "Uses pnpm for every Node project." }, { content: "USES  pnpm for every Node project." }]);
assert.equal(saved.status, "saved");
assert.equal(duplicate.status, "duplicate");
assert.equal((await store.save([{ content: "Uses pnpm for all Node projects." }]))[0].status, "similar");
assert.equal((await store.save([{ content: "Dùng pnpm cho mọi dự án Node." }]))[0].status, "rejected");
assert.equal((await store.save([{ content: "Uses pnpm for all Node projects." }], { dryRun: true }))[0].status, "similar");

// A new database has no Core instructions; saving them is versioned and guarded against lost edits.
const empty = await store.core();
assert.equal(empty.content, "");
const first = await store.saveCore("Reply in English.", empty.version);
assert.equal(first.status, "saved");
assert.equal((await store.saveCore("Stale edit.", empty.version)).status, "conflict");

// MCP over HTTP: both token styles work, a wrong or missing token does not, and a short server token is refused.
const call = (init: RequestInit & { query?: string } = {}) => handleMcp(new Request("http://x/mcp" + (init.query ?? ""), init), store, () => {});
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const post = (headers: Record<string, string>, query = "") => call({ method: "POST", query, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(initialize) });
assert.equal((await post(bearer)).status, 200);
assert.equal((await post({}, `?token=${token}`)).status, 200);
assert.equal((await post({})).status, 401);
assert.equal((await post({ Authorization: "Bearer nope" })).status, 401);
assert.equal((await call({ method: "GET", headers: bearer })).status, 405);
process.env.MCP_TOKEN = "short";
assert.equal((await post({ Authorization: "Bearer short" })).status, 500);
process.env.MCP_TOKEN = token;

// A real client: server identity, instructions with the Core text, exactly the five memory tools, no cleanup tool.
const client = new Client({ name: "test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://memory-lane.test/mcp"), {
  requestInit: { headers: bearer },
  fetch: (input, init) => handleMcp(new Request(input as string, init), store, () => {}),
}));
assert.equal(client.getServerVersion()?.name, "memory-lane");
assert.match(client.getInstructions() ?? "", /Reply in English\./);
assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["memory_delete", "memory_save", "memory_search", "memory_update"]);
const found = await client.callTool({ name: "memory_search", arguments: { query: "pnpm node" } });
assert.match(JSON.stringify(found), /Core instructions, version 2/);
assert.match(JSON.stringify(found), /Uses pnpm for every Node project/);
const again = await client.callTool({ name: "memory_search", arguments: { query: "pnpm node", core_version: 2 } });
assert.match(JSON.stringify(again), /unchanged since you read them/);
await client.close();

// The page API takes the same token in a header only, and edits the Core instructions.
const api = (path: string, init: RequestInit = {}) => handleMemory(new Request("http://x/memory/api" + path, init), store);
assert.equal((await api("")).status, 401);
assert.equal((await api("?token=" + token)).status, 401);
assert.equal((await api("", { headers: bearer })).status, 200);
const coreState = await (await api("?core=1", { headers: bearer })).json() as any;
assert.equal(coreState.core.content, "Reply in English.");
const put = await api("", { method: "PUT", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ content: "Reply in Vietnamese.", version: coreState.core.version }) });
assert.equal(put.status, 200);
assert.equal((await store.core()).content, "Reply in Vietnamese.");

console.log("memory lane: guardrails, Core instructions, MCP auth, tools and API passed");
