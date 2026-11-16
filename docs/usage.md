# Usage Guide

## Run it on your machine

Needs Node.js 22 or newer. Clone the repository and run:

```bash
npm install
npm start                  # local persistent PGlite database
```

Leave it running and open `http://127.0.0.1:4173/memory`. The UI lets you search and delete memories, edit and restore Core instructions, and review cleanup proposals at `/memory/review` (edit, approve, reject and undo).

Local data is stored in `.memory-lane/`. Set `PORT` or `MEMORY_DATA_DIR` to change the port or data directory.

The server creates an MCP token on first run in `.memory-lane/token`, or uses your `MCP_TOKEN` environment variable (at least 32 characters). Read the token file privately to configure an MCP client; the browser UI does not need it. The token is never included in UI HTML or assets.

### Local UI with a Neon database

```bash
npm start -- --db neon
```

Set `MEMORY_DATABASE_URL` to your Neon connection string first, through the environment or an untracked `.env` file. Both the local runner and Core CLI load `.env` from the current working directory without replacing variables already in the shell. Do not commit credentials.

The default remains PGlite even if `MEMORY_DATABASE_URL` is present. Neon mode fails if the URL is missing or startup cannot connect; it never falls back to a different database. Startup checks may initialize or update the memory schema. The UI displays **Neon database · live changes**: edits affect that connected database directly, including production if you select it. Use a separate Neon branch for testing.

`MEMORY_FIXTURES=1 npm start` uses temporary in-memory sample data, reset on restart. Fixtures are refused in Neon mode. There is no automatic copy between PGlite and Neon.

On Windows PowerShell, set environment variables before running the command:

```powershell
$env:MEMORY_FIXTURES = "1"; npm start
```

### Cleanup proposals

Ask a connected AI client to "scan my memories". The `memory_propose` tool groups related memories into proposals; it cannot approve them. Review proposals locally at `/memory/review`.

A deployed MCP server can create proposals while the UI is offline: start the local UI in Neon mode with the **same database** to review them later. Local PGlite proposals require an AI client connected to that local MCP server.

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
