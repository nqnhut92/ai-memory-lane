# Memory Lane

**Shared long-term memory and core instructions across every AI client, because "per my last prompt" shouldn't be part of your workflow.**

Memory Lane is a small [MCP](https://modelcontextprotocol.io) server. Connect it to Claude, ChatGPT, Cursor, Codex or any client that speaks MCP, and they all read and write the same memories: your preferences, your corrections, the facts about you and your projects that an agent should not have to ask twice.

The Web UI runs only on your machine, with no sign-in. MCP clients connect locally or to a deployed server using one token.

## What is in it

- **Versioned Core instructions.** One document you write, which every agent receives first from `memory_search`. Each save bumps a version and keeps the previous text. Agents pass the `core_version` they already have, so the text is sent once per conversation instead of on every search. Saves are guarded against lost edits.
- **Write-time guardrails.** A memory is checked before it is stored. Exact duplicates are recognised through a normalised hash; near duplicates are found with PostgreSQL `pg_trgm` similarity and returned to the agent as `similar`, so it merges instead of piling up variants. Mostly non-English text is rejected so search and de-duplication stay reliable, length and rate limits stop a runaway agent, and `dry_run` shows what a batch would do without writing. The tool instructions also tell agents never to save secrets.
- **Search that favours the newest.** Word matching plus trigram similarity (so typos and word forms still match), shown newest first with each memory's date, so when two disagree the later one wins.
- **One SQL, two engines.** Production runs on serverless PostgreSQL ([Neon](https://neon.tech)); local mode and the tests run the same SQL on [PGlite](https://pglite.dev), an embedded PostgreSQL with `pg_trgm`. No mocks.

## Run it on your machine

Needs Node.js 22 or newer. Clone this repository, then run in its folder:

```bash
npm install
npm start                  # local persistent PGlite database
# npm start -- --db neon    # connect the local UI and MCP to Neon instead
```

Leave it running and open `http://127.0.0.1:4173/memory`. The UI lets you search and delete memories, edit and restore Core instructions, and review cleanup proposals at `/memory/review` (edit, approve, reject and undo). It keeps local data in `.memory-lane/`. Set `PORT` or `MEMORY_DATA_DIR` to change the port or data directory.

The server creates an MCP token on first run in `.memory-lane/token`, or uses your `MCP_TOKEN` environment variable (at least 32 characters). Read the token file privately to configure an MCP client; the browser UI does not need it. The token is never included in UI HTML or assets.

### Local UI with a Neon database

```bash
npm start -- --db neon
```

Set `MEMORY_DATABASE_URL` to your Neon connection string first, through the environment or an untracked `.env` file. Both the local runner and Core CLI load `.env` from the current working directory without replacing variables already in the shell. Do not commit credentials.

The default remains PGlite even if `MEMORY_DATABASE_URL` is present. Neon mode fails if the URL is missing or startup cannot connect; it never falls back to a different database. Startup checks may initialize or update the memory schema. The UI displays **Neon database · live changes**: edits affect that connected database directly, including production if you select it. Use a separate Neon branch for testing.

`MEMORY_FIXTURES=1 npm start` uses temporary in-memory sample data, reset on restart. Fixtures are refused in Neon mode. There is no automatic copy or sync between PGlite and Neon.

### Cleanup proposals

Ask a connected AI client to “scan my memories”. The `memory_propose` tool groups related memories into proposals; it cannot approve them. Review proposals locally at `/memory/review`. A deployed MCP server can create proposals while the UI is offline: start the local UI in Neon mode with the **same database** to review them later. Local PGlite proposals require an AI client connected to that local MCP server.

The server binds to loopback only, and requests with an unexpected `Host` header are refused. Browser API calls must be same-origin; command-line API calls need a bearer token. Browsers without Fetch Metadata support must use the CLI/API instead. This protects against other websites, not other processes or users with access to your machine and token file. That also means web clients such as claude.ai and ChatGPT cannot use a local server: they connect from the internet, so deploy it for those.

The Web UI and its assets are served only by the local runner, outside the deployment’s `public/` directory. Deploying this repository does not publish the Web UI or enable unauthenticated browser API access.

The commands here that start with `NAME=value` are for macOS and Linux shells. In Windows PowerShell, set the variable first: `$env:MEMORY_FIXTURES = "1"; npm start`.

## Deploy it (Vercel + Neon)

A local database lives on one machine. To use the same memory from several machines, deploy it:

1. Create a [Neon](https://neon.tech) project and copy its connection string.
2. Import this repository into [Vercel](https://vercel.com).
3. Set two environment variables:
   - `MEMORY_DATABASE_URL`: the Neon connection string.
   - `MCP_TOKEN`: at least 32 random characters (`openssl rand -hex 32`). The server refuses to run with a shorter one.
4. Deploy. Your endpoint is `https://<your-project>.vercel.app/mcp`.

The schema is created on first use. The deployed MCP includes `memory_propose`; review its proposals using the local UI in Neon mode.

## Connect an AI client

Use the endpoint (`http://127.0.0.1:4173/mcp` locally) with the token either way:

- **Header, preferred:** `Authorization: Bearer <token>`.
- **URL, for clients that only accept a URL:** `https://<host>/mcp?token=<token>`. A token in a URL can end up in logs, so use the header when you can.

Claude Code:

```bash
claude mcp add --transport http memory-lane http://127.0.0.1:4173/mcp --header "Authorization: Bearer <token>"
```

Cursor, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memory-lane": {
      "url": "http://127.0.0.1:4173/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

claude.ai, Claude Desktop and ChatGPT: add a custom connector with the URL form of a deployed server, `https://<your-project>.vercel.app/mcp?token=<token>`, and no sign-in.

To check a connection, ask the agent to "search memory for anything about me": it should call `memory_search`.

### Always-on instructions

Paste this once into each client's custom instructions (Claude, ChatGPT, Cursor rules, `AGENTS.md` for Codex) so every conversation starts with your memory:

```text
I use the Memory Lane MCP server (tools: memory_search, memory_save, memory_update, memory_delete).
- memory_search is your first tool call in every conversation, before reading files, running commands or planning; if it is deferred, load it first. Follow the Core instructions at the top of its result: they are my rules for working with me and override memories.
- Then, for every message of mine that brings something new (a task, topic, person, project, tool, place or preference), call memory_search again before acting on it, with 3-6 English key words. Skip only pure acknowledgements and follow-ups on what you just searched.
- Save what I tell you about myself, my preferences and my corrections with memory_save as we talk, without asking first.
- If memory_search fails, say so in one line and continue with defaults.
```

## Core instructions

Core instructions are yours alone: agents can read them but no MCP tool can change them. Write them in a file (up to 4000 characters) and send them to the running server:

```bash
npm run core -- set my-core.md
npm run core -- show
```

The command talks to the server's API, so it works for a local server and a deployed one. Each `set` bumps the version and keeps the previous text.

For a deployed server, run the same command from a clone of this repository on your machine, pointing it at the deployment. `MCP_TOKEN` is the token you set in Vercel:

```bash
MEMORY_LANE_URL=https://<your-project>.vercel.app MCP_TOKEN=<token> npm run core -- set my-core.md
MEMORY_LANE_URL=https://<your-project>.vercel.app MCP_TOKEN=<token> npm run core -- show
```

Without those variables the command talks to the local server and reads the token from `.memory-lane/token`.

## The API

For building your own page or tools on top. Every request needs `Authorization: Bearer <token>`.

| Request | What it does |
| --- | --- |
| `GET /memory/api?q=&year=&cursor=` | Page through memories, newest first. |
| `DELETE /memory/api` with `{"ids": [1, 2]}` | Delete memories. |
| `GET /memory/api?core=1` | Core instructions, their version and history. |
| `PUT /memory/api` with `{"content": "...", "version": 3}` | Save Core instructions. `version` is the one `GET /memory/api?core=1` returned; the save fails with 409 if it is stale. |

A page you build needs its own sign-in: this server only knows the token, and the token should never reach a browser.

## Security

- The token is the only protection. Use a long random value and HTTPS.
- Memories are stored as plain text so they can be searched. Do not store secrets in them: agents are told not to, but the server does not scan for them.
- Treat memory text as data. A web page or file that asks an agent to save something is not the user asking.

## Development

```bash
npm test          # guardrails, Core instructions, MCP auth and tools, API, on PGlite
npm run typecheck
```

## Structure

```text
api/mcp.ts           MCP endpoint (Streamable HTTP, stateless)
api/memory.ts        Bearer-token API
lib/memory/          store (SQL), tools, Core instructions, PGlite helper
lib/mcp-http.ts      Token check and transport shared by the endpoint
scripts/             local server, Core command, tests
web/                 Shared memory UI assets and local shell (local runner only)
public/index.html    The only static page on a deployment
```
