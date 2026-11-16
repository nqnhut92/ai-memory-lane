# Architecture & Development

## Structure

```text
api/mcp.ts           MCP endpoint (Streamable HTTP, stateless)
api/memory.ts        Bearer-token API
lib/memory/          store (SQL), tools, Core instructions, PGlite helper
lib/mcp-http.ts      Token check and transport shared by the endpoint
scripts/             local server, Core command, tests
web/                 Memory UI assets and local shell (local runner only)
public/index.html    The only static page on a deployment
```

## Storage and search

- **One SQL, two engines:** Production runs on serverless PostgreSQL ([Neon](https://neon.tech)); local mode and the tests run the same SQL on [PGlite](https://pglite.dev), an embedded PostgreSQL with `pg_trgm`. No mocks.
- **Write-time guardrails:** A memory is checked before it is stored. Exact duplicates are recognised through a normalised hash; near duplicates are found with PostgreSQL `pg_trgm` similarity and returned to the agent as `similar`, so it merges instead of piling up variants. Mostly non-English text is rejected so search and de-duplication stay reliable, length and rate limits stop a runaway agent, and `dry_run` shows what a batch would do without writing.
- **Newest-first search:** Word matching plus trigram similarity (so typos and word forms still match), shown newest first with each memory's date, so when two disagree the later one wins.

## Local UI boundary

The local server binds to loopback only, and requests with an unexpected `Host` header are refused. Browser API calls must be same-origin; command-line API calls need a bearer token. Browsers without Fetch Metadata support must use the CLI or API instead. This protects against other websites, not other processes or users with access to the machine and token file. Web clients such as claude.ai and ChatGPT cannot reach a local server and require a deployment.

The Web UI and its assets are served only by the local runner, outside the deployment's `public/` directory. Deploying this repository does not publish the Web UI or enable unauthenticated browser API access.

## Development and testing

```bash
npm test          # guardrails, Core instructions, MCP auth and tools, API, on PGlite
npm run typecheck
```
