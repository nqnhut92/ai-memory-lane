import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LIMITS, neonMemoryStore, type MemoryStore } from "./store.js";
import { PROPOSAL_LIMITS, type ProposeResult } from "./consolidate.js";
import { guarded, type MemoryMcpOptions } from "./mcp.js";

// The cleanup half of the memory tools: an agent proposes, the owner decides on the /memory/review page. It needs that
// page, so servers without it simply do not register this tool.
function describeProposal(result: ProposeResult): string {
  const ids = (result.status === "proposed" ? result.proposal.memoryIds : result.ids).map((id) => "#" + id).join(" ");
  if (result.status === "refused") return `not proposed (${ids || "no valid ids"}): ${result.reason}`;
  const { proposal } = result;
  return `proposed ${proposal.id} (${proposal.kind}, ${proposal.action.replace("_", " ")}): ${ids}`
    + (proposal.newWords.length ? `\n  words in final_text that no source has: ${proposal.newWords.join(", ")}. A merged memory may only say what its sources say; the owner will see this note.` : "");
}


export function registerProposeTool(server: McpServer, options: MemoryMcpOptions & { reviewPlace: string; scanGuide: string }): void {
  const store = (): MemoryStore => options.memoryStore ?? neonMemoryStore();

  server.registerTool("memory_propose", {
    title: "Propose memory cleanup",
    description: `Propose what to do with memories that cover the same subject, for the owner to approve, edit or reject on ${options.reviewPlace}. Nothing changes until the owner approves. ${options.scanGuide} kind is duplicate (they state the same fact), superseded (a newer memory replaces older ones) or conflict (they disagree and their dates do not settle it). final_text is the one memory that should remain, in English, saying only what the listed memories say: add no fact; omit it only for a conflict you cannot settle. The remaining memory keeps the newest date and every tag of the group. Do not memory_update or memory_delete memories you have put in a proposal.`,
    inputSchema: {
      proposals: z.array(z.object({
        ids: z.array(z.number().int().positive()).min(PROPOSAL_LIMITS.minGroup).max(PROPOSAL_LIMITS.maxGroup).describe("Ids of the memories in the group"),
        kind: z.enum(["duplicate", "superseded", "conflict"]),
        final_text: z.string().max(LIMITS.maxChars * 2).optional().describe("The one memory that should remain"),
        reason: z.string().min(1).max(PROPOSAL_LIMITS.maxReason).describe("One line: why these belong together and why this outcome"),
      })).min(1).max(PROPOSAL_LIMITS.maxBatch),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ proposals }) => guarded(async () => {
    const results = await store().propose(proposals.map(({ ids, kind, final_text, reason }) => ({ ids, kind, finalText: final_text, reason })));
    const stored = results.filter((result) => result.status === "proposed").length;
    return `${results.map(describeProposal).join("\n")}\n\n${stored} of ${results.length} stored. Nothing has changed: the owner decides on ${options.reviewPlace}.`;
  }));
}
