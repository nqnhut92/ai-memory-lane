import { handleMcpHttp } from "../lib/mcp-http.js";
import { createServer } from "../lib/server.js";
import type { MemoryStore } from "../lib/memory/store.js";

/** The server is reachable from the internet when deployed, so MCP_TOKEN must be long enough to resist guessing. */
export const MIN_TOKEN_LENGTH = 32;

export function handleMcp(request: Request, memoryStore?: MemoryStore, log: (line: string) => void = console.log): Promise<Response> {
  return handleMcpHttp(request, {
    build: (coreInstructions) => createServer({ memoryStore, coreInstructions }),
    memoryStore, log, minTokenLength: MIN_TOKEN_LENGTH,
  });
}

export const GET = (request: Request): Promise<Response> => handleMcp(request);
export const POST = GET;
export const DELETE = GET;
