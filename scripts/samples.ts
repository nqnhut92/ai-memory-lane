import type { NewMemory } from "../lib/memory/store.js";

// Sample memories for MEMORY_FIXTURES=1.
export const sampleMemories: NewMemory[] = [
  { content: "Prefers short answers with a code example over long explanations.", tags: ["style"] },
  { content: "Uses pnpm for every Node project.", tags: ["node", "tooling"] },
  { content: "Writes commit messages in the imperative mood, such as \"Fix crash when the file is empty\".", tags: ["git"] },
  { content: "The billing service runs on PostgreSQL 16 and is deployed to Vercel.", tags: ["infra"] },
  { content: "Wants tests added or updated with every behavior change.", tags: ["testing"] },
];
