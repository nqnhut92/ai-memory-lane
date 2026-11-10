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
  return server;
}
