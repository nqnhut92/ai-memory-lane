import { readFileSync } from "node:fs";
import { handleMcp } from "../api/mcp.js";
import { handleMemoryApi } from "./memory/api.js";
import type { MemoryStore } from "./memory/store.js";
import { localGuard, localHost } from "./local-guard.js";
import { memoryPage } from "./pages.js";

// Explicit map: URL input is never joined to a filesystem path. Assets stay outside deployment's public/.
const assets = new Map([
  ["base.css", "text/css"], ["scroll.css", "text/css"], ["memory.css", "text/css"], ["shell.css", "text/css"],
  ["memory.js", "text/javascript"], ["memory-review.js", "text/javascript"], ["theme.js", "text/javascript"],
  ["shell.js", "text/javascript"], ["theme-controller.js", "text/javascript"], ["memory.svg", "image/svg+xml"],
]);
const headers = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export function localApp(store: MemoryStore, port: number, mode: "local" | "neon") {
  const guard = localGuard(port);
  return async (request: Request): Promise<Response> => {
    let response: Response;
    if (!localHost(request.headers.get("host"), port)) response = new Response("Forbidden", { status: 403 });
    else {
      const path = new URL(request.url).pathname;
      if (["/mcp", "/api/mcp"].includes(path)) return handleMcp(request, store);
      else if (["/memory/api", "/api/memory"].includes(path)) return handleMemoryApi(request, guard, store);
      else if (!["GET", "HEAD"].includes(request.method)) response = new Response("Method not allowed", { status: 405 });
      else if (path === "/") response = new Response(null, { status: 302, headers: { Location: "/memory" } });
      else if (path === "/memory" || path === "/memory/review") response = new Response(memoryPage(mode, path.endsWith("/review")), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      else if (path.startsWith("/assets/") && assets.has(path.slice(8))) {
        const name = path.slice(8);
        const file = new URL(`../web/${name === "memory.svg" ? "icons/memory.svg" : name}`, import.meta.url);
        response = new Response(readFileSync(file), { headers: { "Content-Type": assets.get(name)! } });
      } else response = new Response("Not found", { status: 404 });
    }
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  };
}
