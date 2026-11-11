import { loadLocalEnv } from "../lib/local-config.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Show or set the Core instructions through the server's API, so it works for a local server and a deployed one.
//   npm run core -- show
//   npm run core -- set my-core.md
// MEMORY_LANE_URL (default http://127.0.0.1:4173) and MCP_TOKEN (default: the token the local server generated).
try { loadLocalEnv(); } catch { console.error("Could not load .env."); process.exit(1); }
const base = (process.env.MEMORY_LANE_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const tokenFile = join(process.env.MEMORY_DATA_DIR || ".memory-lane", "token");
const token = process.env.MCP_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
const [command, file] = process.argv.slice(2);

async function call(init: RequestInit = {}) {
  const response = await fetch(`${base}/memory/api?core=1`, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body = await response.json() as any;
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as { status?: string; core: { content: string; version: number } };
}

if (!token) { console.error("No MCP_TOKEN. Set it, or start the local server once so it creates .memory-lane/token."); process.exit(1); }
try {
  if (command === "show") {
    const { core } = await call();
    console.log(`Core instructions, version ${core.version}\n\n${core.content || "(empty)"}`);
  } else if (command === "set" && file) {
    const { core } = await call();
    const result = await call({ method: "PUT", body: JSON.stringify({ content: readFileSync(file, "utf8"), version: core.version }) });
    console.log(result.status === "unchanged" ? `No change: version ${result.core.version} already has this text.` : `Saved: version ${result.core.version}.`);
  } else {
    console.error("Usage: npm run core -- show | set <file>");
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
