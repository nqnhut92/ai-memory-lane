# Decisions Log

- **Run the same SQL on Neon and PGlite instead of mocking:** Embedded PGlite with `pg_trgm` lets local mode and tests exercise real PostgreSQL queries and schema checks without a remote database.
- **Keep the Web UI local-only outside `public/`:** Deploying only the stateless MCP/API endpoints and `public/index.html` avoids shipping an unauthenticated browser UI or exposing `MCP_TOKEN` to clients.
- **Enforce loopback, `Host`, and Fetch Metadata checks on the local server:** Prevents malicious websites from calling the local UI APIs via cross-origin requests without requiring sign-in for local use.
- **Version Core instructions with `core_version` and `include_core`:** Lets agents receive Core instructions once per conversation instead of repeating them on every `memory_search`, while supporting clients that strip instruction-prefixed tool output.
- **Reject mostly non-English memories at write time:** Keeps keyword and `pg_trgm` similarity matching reliable across mixed-language conversations.
- **Separate `memory_propose` from approval:** Allows deployed or background agents to group redundant memories into proposals while keeping approval, editing, and undo strictly human-driven in `/memory/review`.
