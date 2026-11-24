# AGENTS.md

## 1. Project Overview & Stack
- **Purpose:** Standalone export of Memory Lane — an MCP server and local Web UI for shared long-term AI memory and versioned Core instructions.
- **Stack:** TypeScript (ESM), Node.js 22+, `@modelcontextprotocol/sdk`, Zod, PostgreSQL (Neon) / PGlite, Vercel.
- **Docs Map:** Read relevant docs before modifying specific areas:
  - Usage, API & client setup: `docs/usage.md`
  - Architecture & storage engines: `docs/architecture.md`
  - Decisions log: `docs/decisions.md`

## 2. Essential Commands
- **Start (Local Web UI, PGlite):** `npm start`
- **Start (Neon mode):** `npm start -- --db neon`
- **Test (Full):** `npm test`
- **Typecheck:** `npm run typecheck`

## 3. Hard Constraints & Guardrails
- **Never:** **Never edit files, commit, or push directly in this repository.** Any direct commit will be overwritten by the next automated sync from the upstream source repository.
- **Always:** Make all edits (shared files or `memory-lane/` overlay files including `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/`, and `.github/`) in the upstream source repository, validate there, and let the sync workflow publish updates here.

## 4. Code Style & Patterns
- Plain ESM TypeScript (`"type": "module"`) with `.ts` imports resolved by `tsx` / `tsc --noEmit`.
- Keep SQL compatible with both Neon PostgreSQL and embedded PGlite.

## 5. Definition of Done
Before finishing any upstream change affecting Memory Lane:
1. Run `npm test` and `npm run typecheck` in the upstream source repository.
2. Update relevant files in `docs/` if public APIs or architecture changed.
