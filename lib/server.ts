import { registerProposeTool } from "./memory/propose-mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MEMORY_INSTRUCTIONS, coreBlock, registerMemoryTools, type MemoryMcpOptions } from "./memory/mcp.js";

/** coreInstructions: the owner's Core instructions, added for clients that pass server instructions to the model. */
export function createServer(options: MemoryMcpOptions & { coreInstructions?: { content: string; version: number } } = {}): McpServer {
  const server = new McpServer(
    {
      name: "memory-lane",
      title: "Memory Lane",
      version: "1.0.0",
      description: "Shared long-term memory and core instructions across every AI client.",
    },
    // Clients keep these from the moment they connect; memory_search always returns the latest Core instructions.
    { instructions: `${options.coreInstructions ? coreBlock(options.coreInstructions) : ""}${MEMORY_INSTRUCTIONS}` },
  );
  registerMemoryTools(server, options);
  registerProposeTool(server, { ...options,
    reviewPlace: "the local Web UI at /memory/review (run npm start -- --db neon when using a deployed server, with the same database)",
    scanGuide: "For a scan, browse memory_search without a query and follow its pagination to load the memories. Group memories about the same subject and propose each group separately. Do not update or delete memories included in a proposal.",
  });
  return server;
}
