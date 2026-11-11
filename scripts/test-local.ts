import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { pgliteMemoryStore } from "../lib/memory/local.js";
import { localApp } from "../lib/local-app.js";
import { localGuard } from "../lib/local-guard.js";
import { configureDatabase, databaseMode } from "../lib/local-config.js";

const token = "t".repeat(40);
process.env.MCP_TOKEN = token;
const port = 4173, origin = `http://127.0.0.1:${port}`;
const host = { Host: `127.0.0.1:${port}` };
const same = { ...host, "Sec-Fetch-Site": "same-origin" };
const guard = localGuard(port);
const guarded = (headers: Record<string, string>, method = "GET") => guard(new Request(origin + "/memory/api", { method, headers }));
for (const badHost of ["evil.test:4173", "localhost:4174", "127.0.0.1.evil.test:4173"]) assert.equal(guarded({ ...same, Host: badHost })?.status, 403);
assert.equal(guarded({ ...host, Authorization: `Bearer ${token}` }), undefined);
assert.equal(guarded({ ...same, Authorization: "Bearer wrong" })?.status, 401);
assert.equal(guarded({ ...same, Authorization: "Basic wrong" })?.status, 401);
assert.equal(guarded(host)?.status, 401);
for (const site of ["cross-site", "same-site", "none"]) assert.equal(guarded({ ...same, "Sec-Fetch-Site": site })?.status, 401);
assert.equal(guarded(same), undefined);
assert.equal(guarded({ ...same, Origin: "http://localhost:9999" })?.status, 403);
for (const method of ["PUT", "POST", "DELETE"]) {
  assert.equal(guarded(same, method)?.status, 403);
  assert.equal(guarded({ ...same, Origin: "null" }, method)?.status, 403);
  assert.equal(guarded({ ...same, Origin: origin }, method), undefined);
  assert.equal(guarded({ ...host, Authorization: `Bearer ${token}` }, method), undefined);
}
assert.equal(guarded(same, "OPTIONS")?.status, 405);
assert.equal(databaseMode([]), "local");
assert.equal(databaseMode(["--db=neon"]), "neon");
assert.equal(databaseMode(["--db", "local"]), "local");
for (const args of [["--db"], ["--db", "remote"], ["--host", "0.0.0.0"], ["--db=neon", "extra"]]) assert.throws(() => databaseMode(args), /Usage/);
process.env.MEMORY_DATABASE_URL = "must-not-be-used";
assert.equal(configureDatabase([]), "local");
assert.equal(process.env.MEMORY_DATABASE_URL, undefined);
assert.throws(() => configureDatabase(["--db=neon"]), /requires/);
process.env.MEMORY_FIXTURES = "1";
assert.throws(() => configureDatabase(["--db=neon"]), /Fixtures/);
delete process.env.MEMORY_FIXTURES;

const { store, db } = pgliteMemoryStore();
try {
  const app = localApp(store, port, "local");
  const request = (path: string, init: RequestInit = {}) => app(new Request(origin + path, { ...init, headers: init.headers ?? same }));
  assert.equal((await request("/")).headers.get("location"), "/memory");
  for (const path of ["/memory", "/memory/review"]) {
    const response = await request(path);
    const html = await response.text();
    assert.match(html, /Local database/);
    assert.ok(!html.includes(token));
    assert.ok(!html.includes("data-login"));
    assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    for (const [, asset] of html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)) assert.equal((await request(asset)).status, 200, asset);
  }
  for (const path of ["/assets/missing.js", "/assets/../.env", "/assets/%2e%2e/.env", "/web/memory.js", "/assets/%2e%2e%2f.env"]) assert.equal((await request(path)).status, 404, path);
  const denied = await request("/memory/api", { headers: host });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  const apiResponse = await request("/memory/api");
  assert.equal(apiResponse.status, 200);
  assert.equal(apiResponse.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  const saved = await store.save([
    { content: "The office walls are painted blue.", date: "2025-01-01", force: true },
    { content: "The office walls are now painted green.", date: "2026-01-01", force: true },
  ]);
  const ids = saved.map(item => { assert.equal(item.status, "saved"); return item.memory.id; });
  await store.propose([{ ids, kind: "superseded", finalText: "The office walls are now painted green.", reason: "The newer color replaces the old one." }]);
  const review = await (await request("/memory/api?review=1")).json() as any;
  assert.equal(review.pending.length, 1);
  const proposal = review.pending[0].id;
  const decide = (decision: string) => request("/memory/api", { method: "POST", headers: { ...same, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ proposal, decision, ...(decision === "approve" ? { text: "The office walls are now painted green." } : {}) }) });
  assert.equal((await decide("approve")).status, 200);
  assert.equal((await store.list()).items.length, 1);
  assert.equal((await decide("undo")).status, 200);
  assert.equal((await store.list()).items.length, 2);
} finally { await db.close(); }

// Exercise the real process, including .env loading, CLI auth and persistent PGlite across restart.
const temp = mkdtempSync(join(tmpdir(), "memory-lane-local-"));
const entry = resolve("scripts/local-server.ts"), core = resolve("scripts/core.ts");
const args = [...process.execArgv];
let child: ChildProcess | undefined;
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => { current.kill("SIGKILL"); reject(new Error("Runner did not stop")); }, 10_000);
    current.once("exit", () => { clearTimeout(timeout); done(); });
    current.kill("SIGTERM");
  });
}
const socket = createServer();
await new Promise<void>(done => socket.listen(0, "127.0.0.1", done));
const freePort = (socket.address() as { port: number }).port;
await new Promise<void>((done, reject) => socket.close(error => error ? reject(error) : done()));
const base = `http://127.0.0.1:${freePort}`;
const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(freePort), MEMORY_DATA_DIR: join(temp, "data"), MCP_TOKEN: token, MEMORY_LANE_URL: base };
delete childEnv.MEMORY_DATABASE_URL;
async function start() {
  let output = "";
  child = spawn(process.execPath, [...args, entry], { cwd: temp, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Runner exited: ${output}`);
    if (output.includes("Memory Lane:")) return;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error("Runner startup timed out");
}
try {
  const failedNeonEnv: NodeJS.ProcessEnv = { ...childEnv, MEMORY_DATABASE_URL: "invalid-connection-string" };
  delete failedNeonEnv.MCP_TOKEN;
  const failedNeon = spawnSync(process.execPath, [...args, entry, "--db", "neon"], { cwd: temp, env: failedNeonEnv, encoding: "utf8", timeout: 15_000 });
  assert.equal(failedNeon.error, undefined);
  assert.notEqual(failedNeon.status, 0);
  assert.equal(existsSync(join(temp, "data")), false, "Failed Neon startup must not create local token/data files");
  assert.ok(!failedNeon.stderr.includes("invalid-connection-string"));
  writeFileSync(join(temp, ".env"), "MEMORY_DATABASE_URL=ignored-in-default-local-mode\n");
  await start();
  const file = join(temp, "core.md");
  writeFileSync(file, "Reply with concise answers.");
  const cli = (command: string[]) => execFileSync(process.execPath, [...args, core, ...command], { cwd: temp, env: childEnv, encoding: "utf8" });
  assert.match(cli(["set", file]), /Saved/);
  assert.match(cli(["show"]), /Reply with concise answers/);
  await stop();
  await start();
  assert.match(cli(["show"]), /Reply with concise answers/);
  assert.equal((await fetch(base + "/memory/api")).status, 401);
  // Standalone source paths are resolved relative to the application, not the caller's cwd.
  assert.equal((await fetch(base + "/assets/memory.js")).status, 200);
} finally {
  await stop();
  rmSync(temp, { recursive: true, force: true });
}
console.log("local UI: guard, assets, database selection, review, CLI and persistence passed");
