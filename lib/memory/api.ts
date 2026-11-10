import { z } from "zod";
import { LIMITS, MemoryInputError, neonMemoryStore, type CoreSaveResult, type MemoryStore } from "./store.js";

// Owner-only API: read the timeline, delete memories, read and edit the Core instructions (GET ?core=1, PUT), and decide on cleanup proposals (GET ?review=1, POST). Memories are saved only through MCP tools; Core instructions only here.
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Vary": "Cookie, Authorization", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
const idsSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }).strict();
const version = z.number().int().min(0);
// Decisions on cleanup proposals (the /memory/review page). text: the owner's edit of the final memory.
const decisionSchema = z.union([
  z.object({ proposal: z.number().int().positive(), decision: z.literal("approve"), text: z.string().max(LIMITS.maxChars * 2).optional() }).strict(),
  z.object({ proposal: z.number().int().positive(), decision: z.enum(["reject", "undo"]) }).strict(),
]);
const coreSchema = z.union([
  z.object({ content: z.string().max(LIMITS.coreMaxChars * 2), version }).strict(),
  z.object({ restore: z.number().int().positive(), version }).strict(),
]);

async function coreState(store: MemoryStore) {
  const [core, history] = await Promise.all([store.core(), store.coreHistory()]);
  return { core, history, limit: LIMITS.coreMaxChars };
}

const coreStatus: Record<CoreSaveResult["status"], number> = { saved: 200, unchanged: 200, conflict: 409, not_found: 404 };

/** Answers a request that may not pass: return a Response to refuse it, nothing to let it through. */
export type MemoryApiGuard = (request: Request) => Response | undefined;

export function memoryJson(data: unknown, status = 200): Response {
  return json(data, status);
}

/** The memory API. The guard decides who may call it: a signed-in session, a bearer token, or anything else a server prefers. */
export async function handleMemoryApi(request: Request, guard: MemoryApiGuard, supplied?: MemoryStore): Promise<Response> {
  const refused = guard(request);
  if (refused) return refused;
  const url = new URL(request.url);
  if (!["GET", "DELETE", "PUT", "POST"].includes(request.method)) return json({ error: "Method not allowed." }, 405);
  try {
    const store = supplied ?? neonMemoryStore();
    if (request.method === "GET" && url.searchParams.has("core")) return json(await coreState(store));
    if (request.method === "GET" && url.searchParams.has("review")) return json(await store.proposals());
    if (request.method === "GET") {
      const read = (name: string) => url.searchParams.get(name)?.slice(0, 200) || undefined;
      const year = Number(read("year"));
      const timeZone = read("tz");
      const cursor = read("cursor");
      const filter = {
        query: read("q"), timeZone,
        year: Number.isInteger(year) && year > 1989 && year < 3000 ? year : undefined,
      };
      const page = await store.list({ ...filter, cursor, limit: 100 });
      if (cursor) return json(page);
      // `facets` follow the search (year navigation); `stats` describes all memories.
      return json({ ...page, facets: await store.facets(filter), stats: await store.stats(timeZone), review: { pending: await store.pendingProposals() } });
    }
    if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "JSON required." }, 415);
    if (request.method === "PUT") {
      const parsed = coreSchema.safeParse(JSON.parse(await request.text()));
      if (!parsed.success) return json({ error: "Invalid request." }, 400);
      const body = parsed.data;
      const result = "restore" in body ? await store.restoreCore(body.restore, body.version) : await store.saveCore(body.content, body.version);
      if (result.status === "not_found") return json({ error: "That version no longer exists." }, 404);
      const error = result.status === "conflict" ? "Core instructions changed in another tab or device. Reload to see the newer text." : undefined;
      return json({ status: result.status, ...(error ? { error } : {}), ...await coreState(store) }, coreStatus[result.status]);
    }
    if (request.method === "POST") {
      const parsed = decisionSchema.safeParse(JSON.parse(await request.text()));
      if (!parsed.success) return json({ error: "Invalid request." }, 400);
      const body = parsed.data;
      const result = body.decision === "approve" ? await store.approveProposal(body.proposal, body.text)
        : body.decision === "reject" ? await store.rejectProposal(body.proposal) : await store.undoProposal(body.proposal);
      const state = await store.proposals();
      if (result.status === "not_found") return json({ error: "That proposal is no longer waiting. The list was refreshed.", ...state }, 404);
      if (result.status === "stale") return json({ error: "Those memories changed after the scan, so the proposal was dropped. Scan again to get a fresh one.", ...state }, 409);
      if (result.status === "refused") return json({ error: result.reason, ...state }, 409);
      return json({ status: result.status, ...state });
    }
    const parsed = idsSchema.safeParse(JSON.parse(await request.text()));
    if (!parsed.success) return json({ error: "Invalid request." }, 400);
    return json({ deleted: await store.remove(parsed.data.ids) });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: "Invalid JSON." }, 400);
    if (error instanceof MemoryInputError) return json({ error: error.message }, 400);
    return json({ error: "Memory storage is unavailable. Nothing was changed." }, 503);
  }
}
