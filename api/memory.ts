import { bearerToken, sameToken } from "../lib/mcp-http.js";
import { handleMemoryApi, memoryJson, type MemoryApiGuard } from "../lib/memory/api.js";
import type { MemoryStore } from "../lib/memory/store.js";
import { MIN_TOKEN_LENGTH } from "./mcp.js";

// There is no page and no sign-in: this API takes the same MCP_TOKEN as /mcp, in an `Authorization: Bearer` header.
// Anyone who builds a page on top of it brings their own sign-in.
const guard: MemoryApiGuard = (request) => {
  const expected = process.env.MCP_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return memoryJson({ error: `MCP_TOKEN must be set to at least ${MIN_TOKEN_LENGTH} characters.` }, 503);
  if (!sameToken(bearerToken(request) ?? "", expected)) return memoryJson({ error: "Unauthorized." }, 401);
};

export const handleMemory = (request: Request, supplied?: MemoryStore): Promise<Response> => handleMemoryApi(request, guard, supplied);

export const GET = (request: Request) => handleMemory(request);
export const DELETE = GET;
export const PUT = GET;
export const POST = GET;
