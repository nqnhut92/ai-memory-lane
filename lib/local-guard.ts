import { bearerToken, sameToken } from "./mcp-http.js";
import { memoryJson, type MemoryApiGuard } from "./memory/api.js";

export function localHost(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

// Browser access is same-origin only; command-line clients continue to use bearer authentication.
export function localGuard(port: number): MemoryApiGuard {
  return (request) => {
    const host = request.headers.get("host");
    if (!localHost(host, port)) return memoryJson({ error: "Forbidden." }, 403);
    if (request.method === "OPTIONS") return memoryJson({ error: "Method not allowed." }, 405);
    if (request.headers.has("authorization")) {
      const expected = process.env.MCP_TOKEN;
      if (!expected || expected.length < 32 || !sameToken(bearerToken(request) ?? "", expected)) {
        return memoryJson({ error: "Unauthorized." }, 401);
      }
      return;
    }
    if (request.headers.get("sec-fetch-site") !== "same-origin") return memoryJson({ error: "Same-origin browser access or a bearer token is required." }, 401);
    const origin = request.headers.get("origin");
    const expected = `http://${host}`;
    if ((origin !== null && origin !== expected) || (["PUT", "POST", "DELETE"].includes(request.method) && origin !== expected)) {
      return memoryJson({ error: "Forbidden." }, 403);
    }
  };
}
