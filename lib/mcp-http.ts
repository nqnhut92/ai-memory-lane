import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { neonMemoryStore, type MemoryStore } from "./memory/store.js";

function json(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status });
}

/** The token in `Authorization: Bearer <token>`, or nothing. */
export function bearerToken(request: Request): string | undefined {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

/** Constant-time comparison, so response timing does not reveal how much of a guess was right. */
export function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Accepts `Authorization: Bearer <token>` or `?token=<token>` (for clients that only take a URL). */
function authorized(request: Request, expected: string): boolean {
  return sameToken(bearerToken(request) ?? new URL(request.url).searchParams.get("token") ?? "", expected);
}

/** True after this server instance has answered one request, so the log can tell a cold start from a warm one. */
let warm = false;

/** What the request asks for, e.g. "tools/call memory_search", without consuming the body. */
async function describeCall(request: Request): Promise<string> {
  try {
    const body = await request.clone().json();
    const call = Array.isArray(body) ? body[0] : body;
    return call?.method === "tools/call" ? `tools/call ${String(call.params?.name).slice(0, 64)}` : String(call?.method ?? "unknown").slice(0, 64);
  } catch {
    return "unknown";
  }
}

async function initialCore(supplied?: MemoryStore): Promise<{ content: string; version: number } | undefined> {
  if (!supplied && !process.env.MEMORY_DATABASE_URL) return undefined;
  let timer: number | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = Number(setTimeout(resolve, 1500)); });
  try {
    return await Promise.race([(supplied ?? neonMemoryStore()).core().then((core) => (core.content ? core : undefined)), timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface McpHttpOptions {
  /** Builds the server for one request; core is the owner's Core instructions, only on `initialize`. */
  build: (core: { content: string; version: number } | undefined) => McpServer;
  memoryStore?: MemoryStore;
  log?: (line: string) => void;
  /** Refuse to run with a shorter MCP_TOKEN, for servers that are reachable from the internet. */
  minTokenLength?: number;
}

/** Streamable HTTP for an MCP server: token check, stateless transport, one log line per call. */
export async function handleMcpHttp(request: Request, { build, memoryStore, log = console.log, minTokenLength = 1 }: McpHttpOptions): Promise<Response> {
  const expected = process.env.MCP_TOKEN;
  if (!expected) return json(500, "MCP_TOKEN is not configured on the server");
  if (expected.length < minTokenLength) return json(500, `MCP_TOKEN must be at least ${minTokenLength} characters`);
  if (!authorized(request, expected)) return json(401, "Unauthorized");
  // A stateless server has nothing to push, so it offers no standalone SSE stream. Without this 405 the
  // GET opens an empty stream that dies at the function timeout, and strict clients (Antigravity) retry
  // it until they mark the server as failed. Per the spec, clients treat 405 as "no stream" and use POST only.
  if (request.method === "GET") {
    const response = json(405, "Method not allowed");
    response.headers.set("Allow", "POST, DELETE");
    return response;
  }

  // Stateless: a fresh server and transport per request, so it runs on serverless functions.
  const started = Date.now();
  const call = await describeCall(request);
  const cold = !warm;
  warm = true;
  // Only initialize carries server instructions, so only it reads the Core instructions. A slow or missing memory
  // database never holds up the connection: the agent still gets them from memory_search.
  const coreInstructions = call === "initialize" ? await initialCore(memoryStore) : undefined;
  const server = build(coreInstructions);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const setupMs = Date.now() - started;
  const response = await transport.handleRequest(request);
  // With JSON responses the handler resolves once the tool has finished, so this is the whole server-side time.
  log(JSON.stringify({ mcp: { call, ms: Date.now() - started, setupMs, status: response.status, cold } }));
  return response;
}
