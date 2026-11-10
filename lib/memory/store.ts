import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { cleanCore } from "./core.js";
import { CORE_SEED } from "./core-seed.js";
import { consolidation, type ConsolidationStore } from "./consolidate.js";

// Shared memory for every agent that connects to the MCP server. Plain text on purpose (it must be searchable),
// so it must never hold secrets. Limits keep a runaway agent from filling the database.
export const LIMITS = {
  maxChars: 2000,
  maxMemories: 20000,
  maxTags: 8,
  maxTagChars: 32,
  maxBatch: 25,
  // New rows allowed per window. Exact duplicates are free, so a loop repeating one fact never counts.
  rateCount: 150,
  rateMinutes: 10,
  similarity: 0.55,
  // Core instructions: returned with every memory_search, so they stay short. Older versions kept for restore.
  coreMaxChars: 4000,
  coreHistory: 20,
} as const;

/** Storage quota shown on the page (Neon's free plan includes 1 GB per project). Override with MEMORY_DB_QUOTA_MB. */
export function storageQuotaBytes(): number {
  const mb = Number(process.env.MEMORY_DB_QUOTA_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 1024) * 1024 * 1024;
}

export interface Memory {
  id: number;
  content: string;
  tags: string[];
  /** Where the memory sits on the timeline: when it was saved, or the day the user says the fact is from. */
  occurredAt: string;
  /** occurredAt came from a date without a time (noon UTC on that day); show the date only. */
  dateOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewMemory { content: string; tags?: string[]; date?: string; force?: boolean }

export type SaveResult =
  // related: existing memories on the same subject, so the agent can update or delete the one this replaces.
  | { status: "saved"; memory: Memory; related: Memory[] }
  | { status: "duplicate"; memory: Memory }
  | { status: "similar"; content: string; candidates: (Memory & { similarity: number })[] }
  | { status: "rejected"; content: string; reason: string }
  // Dry run only: nothing is written.
  | { status: "would_save"; content: string; tags: string[]; date: string | null }
  | { status: "duplicate_in_batch"; content: string; earlier: string }
  | { status: "similar_in_batch"; content: string; earlier: string; similarity: number };

export type UpdateResult =
  | { status: "updated"; memory: Memory }
  | { status: "not_found" }
  | { status: "duplicate"; memory: Memory }
  | { status: "rejected"; reason: string };

/** The owner's Core instructions. version counts saves, so two open pages cannot overwrite each other unnoticed. */
export interface CoreInstructions { content: string; version: number; updatedAt: string }
export interface CoreVersion { id: number; content: string; version: number; savedAt: string }
export type CoreSaveResult =
  | { status: "saved"; core: CoreInstructions }
  | { status: "unchanged"; core: CoreInstructions }
  // Someone saved in between: nothing was written; reload and edit the newer text.
  | { status: "conflict"; core: CoreInstructions }
  | { status: "not_found" };

/** Timeline filters. */
export type MemoryFilter = Omit<ListOptions, "cursor" | "limit">;
export interface ListOptions { year?: number; timeZone?: string; query?: string; cursor?: string; limit?: number }
export interface ListPage { items: Memory[]; next: string | null }
export interface SearchOptions { query: string; limit?: number }

export interface Facets {
  years: { year: number; count: number }[];
}

export interface Stats {
  total: number;
  /** Text stored in memories. */
  bytes: number;
  /** Whole database and the memories table with its indexes, as PostgreSQL reports them. */
  storage: { databaseBytes: number; tableBytes: number; quotaBytes: number };
  years: { year: number; count: number }[];
  limits: typeof LIMITS;
}

export interface MemoryStore extends ConsolidationStore {
  /** With dryRun, runs every check (validation, duplicates, similarity, limits) and reports what would happen, writing nothing. */
  save(items: NewMemory[], options?: { dryRun?: boolean }): Promise<SaveResult[]>;
  update(id: number, patch: { content?: string; tags?: string[]; date?: string }): Promise<UpdateResult>;
  remove(ids: number[]): Promise<number[]>;
  search(options: SearchOptions): Promise<(Memory & { score: number })[]>;
  list(options?: ListOptions): Promise<ListPage>;
  /**
   * Counts for the page's filters. Each facet applies every other active filter but not its own, so a dropdown lists
   * what choosing another value would show. Years apply all filters (they are navigation, not a filter).
   */
  facets(filter?: MemoryFilter): Promise<Facets>;
  stats(timeZone?: string): Promise<Stats>;
  core(): Promise<CoreInstructions>;
  /** Owner only (the /memory page). The replaced text goes to the history; expectedVersion guards against lost edits. */
  saveCore(content: string, expectedVersion: number): Promise<CoreSaveResult>;
  /** Earlier versions, newest first. */
  coreHistory(): Promise<CoreVersion[]>;
  /** Saves an earlier version as the current text; the text it replaces goes to the history too. */
  restoreCore(id: number, expectedVersion: number): Promise<CoreSaveResult>;
}

/** Runs one parameterised statement, or several statements in one transaction. */
export interface SqlRunner {
  query(text: string, params?: unknown[]): Promise<Record<string, any>[]>;
  transaction(statements: string[]): Promise<void>;
}

export class MemoryInputError extends Error {}

/** Same text after Unicode NFC and whitespace cleanup. Vietnamese "ệ" typed as one or two code points compares equal. */
export function canonical(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Accent- and case-insensitive form used for similarity and search: "Dùng pnpm" -> "dung pnpm". */
export function fold(text: string): string {
  return canonical(text).normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

export function contentHash(text: string): string {
  return createHash("sha256").update(canonical(text).toLowerCase()).digest("hex");
}

const TIME_ZONE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

function cleanTags(tags: string[] | undefined): string[] {
  const list = [...new Set((tags ?? []).map((tag) => canonical(tag).toLowerCase()).filter(Boolean))];
  if (list.length > LIMITS.maxTags) throw new MemoryInputError(`At most ${LIMITS.maxTags} tags per memory.`);
  const long = list.find((tag) => tag.length > LIMITS.maxTagChars);
  if (long) throw new MemoryInputError(`Tag "${long}" is longer than ${LIMITS.maxTagChars} characters.`);
  return list;
}

/**
 * Memories are stored in English, whatever language the conversation is in: one language keeps dedup and search
 * reliable across clients. A few non-English words (names, a song title) are fine; a mostly non-English text is not.
 * Vietnamese without diacritics cannot be told apart from English here; the tool rules ask agents to translate.
 */
export function looksNonEnglish(text: string): boolean {
  const words = text.match(/\p{L}+/gu) ?? [];
  const foreign = words.filter((word) => /[^A-Za-z]/.test(word)).length;
  return foreign >= 3 && foreign / words.length >= 0.3;
}

export function cleanContent(content: string): string {
  const value = canonical(content);
  if (!value) throw new MemoryInputError("Memory content is empty.");
  if (value.length > LIMITS.maxChars) throw new MemoryInputError(`Memory is ${value.length} characters; the limit is ${LIMITS.maxChars}. Save a shorter summary.`);
  if (looksNonEnglish(value)) throw new MemoryInputError("Memories are stored in English. Translate this memory into English and save it again, keeping names, titles and code in their original form.");
  return value;
}

/** "2024-05-17" -> noon UTC that day, so the calendar date is the same in every time zone from UTC-11 to UTC+11. */
function cleanDate(date: string | undefined): string | null {
  if (date === undefined || date === "") return null;
  const match = /^\d{4}-\d{2}-\d{2}$/.exec(date.trim());
  const value = match && new Date(`${match[0]}T12:00:00Z`);
  if (!match || !value || Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== match[0]) throw new MemoryInputError(`Invalid date "${date}": use YYYY-MM-DD, or omit it.`);
  if (value.getUTCFullYear() < 1990 || value.getTime() > Date.now() + 86_400_000) throw new MemoryInputError(`Date ${date} is out of range: it must be a real past day.`);
  return value.toISOString();
}

/** The day a text opens with: "On 2025-03-04 ...", "As of 2026-10-21, ...", "2024-10-14: ...". Never a date later on. */
// Not "Since ..." or "By ...": dropping those changes the meaning.
const LEADING_DATE = /^(?:(?:on|as of)\s+)?(\d{4}-\d{2}-\d{2})\b[\s,:;.\u2013\u2014-]*/i;

export function leadingDate(content: string): string | null {
  const match = LEADING_DATE.exec(content);
  if (!match) return null;
  try { return cleanDate(match[1]); } catch { return null; }
}

/**
 * The timeline already shows a dated memory's day, so the same day at the start of the text is noise:
 * "On 2025-03-04 Alex tuned ..." on 2025-03-04 is stored as "Alex tuned ...". Other dates stay.
 */
export function withoutTimelineDate(content: string, date: string | null): string {
  if (!date || leadingDate(content) !== date) return content;
  const rest = content.replace(LEADING_DATE, "").trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : content;
}

function cleanTimeZone(timeZone: string | undefined): string {
  if (!timeZone || !TIME_ZONE.test(timeZone)) return "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone }); return timeZone; } catch { return "UTC"; }
}

const iso = (value: unknown): string => new Date(value as string).toISOString();

export function row(record: Record<string, any>): Memory {
  return {
    id: Number(record.id),
    content: record.content,
    tags: record.tags ?? [],
    occurredAt: iso(record.occurred_at),
    dateOnly: Boolean(record.date_only),
    createdAt: iso(record.created_at),
    updatedAt: iso(record.updated_at),
  };
}

export const COLUMNS = "id, content, tags, occurred_at, date_only, created_at, updated_at";

function encodeCursor(memory: Memory): string {
  return Buffer.from(`${memory.occurredAt}|${memory.id}`).toString("base64url");
}

function decodeCursor(cursor: string | undefined): [string, number] | undefined {
  if (!cursor) return;
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!at || Number.isNaN(Date.parse(at)) || !/^\d+$/.test(id ?? "")) throw new MemoryInputError("Invalid cursor.");
  return [new Date(at).toISOString(), Number(id)];
}

/** "Every word appears" conditions for the /memory page filter, where more words should narrow the timeline. */
function wordConditions(query: string, params: unknown[]): string {
  const words = fold(query).split(" ").filter(Boolean).slice(0, 8);
  return words.map((word) => { params.push(word); return `strpos(folded, $${params.length}) > 0`; }).join(" AND ");
}

/** Filler words that would match almost every memory; dropped unless the query has nothing else. */
const STOP_WORDS = new Set(["a", "an", "and", "are", "for", "from", "how", "in", "is", "of", "on", "or", "the", "to", "was", "what", "with"]);

/**
 * SQL for the share of query words found in a memory, from 0 to 1. A memory matches when it holds at least
 * one word, and holding more words ranks it higher, so agents can search with several key words at once
 * ("address language tone") without every word having to appear.
 */
function wordScore(query: string, params: unknown[]): string {
  const all = fold(query).split(" ").filter(Boolean);
  const meaningful = all.filter((word) => !STOP_WORDS.has(word));
  const words = (meaningful.length ? meaningful : all).slice(0, 8);
  const hits = words.map((word) => { params.push(word); return `(CASE WHEN strpos(folded, $${params.length}) > 0 THEN 1 ELSE 0 END)`; });
  return `((${hits.join(" + ")})::float / ${words.length})`;
}

/** SQL conditions for a filter; values go into params as $n placeholders. */
function filterConditions(filter: MemoryFilter, params: unknown[]): string[] {
  const where: string[] = [];
  if (filter.year) {
    params.push(cleanTimeZone(filter.timeZone), filter.year);
    where.push(`extract(year FROM occurred_at AT TIME ZONE $${params.length - 1})::int = $${params.length}`);
  }
  if (filter.query && fold(filter.query)) where.push(`(${wordConditions(filter.query, params)})`);
  return where;
}

/** Shared distinctive words that make two memories "related" at save time. */
const RELATED_WORDS = 3;

/** Reported after a store step so production logs show where the time goes (database wake-up, schema check, query). */
export type MemoryTiming = (event: { step: string; ms: number; [detail: string]: unknown }) => void;

/** The table, index or extension a statement needs is missing: the schema has not been created yet. */
function isMissingSchema(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  return code === "42P01" || code === "42883" || /relation .* does not exist|function .* does not exist/i.test(message ?? "");
}

const SCHEMA_INDEXES = ["memories_occurred_idx", "memories_created_idx", "memories_folded_trgm_idx", "memories_hash_key"];
const SCHEMA_TABLES = ["core_instructions", "core_instructions_history", "memory_proposals", "memory_archive"];

function coreRow(record: Record<string, any>): CoreInstructions {
  return { content: record.content, version: Number(record.version), updatedAt: iso(record.updated_at) };
}

function cleanCoreContent(content: string): string {
  const value = cleanCore(content);
  if (value.length > LIMITS.coreMaxChars) throw new MemoryInputError(`Core instructions are ${value.length} characters; the limit is ${LIMITS.coreMaxChars}. Shorten them.`);
  return value;
}

export function createMemoryStore(sql: SqlRunner, onTiming: MemoryTiming = () => {}): MemoryStore {
  let ready: Promise<void> | undefined;
  /**
   * Creates or upgrades the schema once per server instance. A cold instance first asks one cheap question; the
   * transaction of DDL statements (advisory lock, CREATE EXTENSION, ...) only runs when something is missing.
   */
  function ensureSchema(): Promise<void> {
    ready ??= (async () => {
      const started = Date.now();
      const [state] = await sql.query(
        `SELECT (SELECT count(*) FROM pg_indexes WHERE tablename = 'memories' AND indexname = ANY($1::text[]))::int AS indexes,
           (SELECT count(*) FROM pg_tables WHERE tablename = ANY($2::text[]))::int AS tables,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'confirmed_at') AS legacy`,
        [SCHEMA_INDEXES, SCHEMA_TABLES],
      );
      if (state.indexes === SCHEMA_INDEXES.length && state.tables === SCHEMA_TABLES.length && !state.legacy) { onTiming({ step: "schema-check", ms: Date.now() - started, migrated: false }); return; }
      await migrate();
      onTiming({ step: "schema-check", ms: Date.now() - started, migrated: true });
    })().catch((error) => { ready = undefined; throw error; });
    return ready;
  }
  function migrate(): Promise<void> {
    return sql.transaction([
      "SELECT pg_advisory_xact_lock(87100, 87102)",
      "CREATE EXTENSION IF NOT EXISTS pg_trgm",
      `CREATE TABLE IF NOT EXISTS memories (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND ${LIMITS.maxChars}),
        folded text NOT NULL,
        hash text NOT NULL,
        tags text[] NOT NULL DEFAULT '{}',
        occurred_at timestamptz NOT NULL DEFAULT now(),
        date_only boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (hash)
      )`,
      // Left over from the five-year archive, which was removed: memories no longer age out.
      "ALTER TABLE memories DROP COLUMN IF EXISTS confirmed_at",
      // Scope and source were removed: agents filled them inconsistently and nothing relied on them. The same text in
      // two scopes becomes one memory (the oldest is kept) before text alone has to be unique.
      "DELETE FROM memories a USING memories b WHERE a.hash = b.hash AND a.id > b.id",
      "ALTER TABLE memories DROP COLUMN IF EXISTS scope",
      "ALTER TABLE memories DROP COLUMN IF EXISTS source",
      "CREATE UNIQUE INDEX IF NOT EXISTS memories_hash_key ON memories (hash)",
      "CREATE INDEX IF NOT EXISTS memories_occurred_idx ON memories (occurred_at DESC, id DESC)",
      "CREATE INDEX IF NOT EXISTS memories_created_idx ON memories (created_at)",
      "CREATE INDEX IF NOT EXISTS memories_folded_trgm_idx ON memories USING gin (folded gin_trgm_ops)",
      // One row (id 1). Seeded once with the starting text; a later migration never overwrites the owner's edits.
      `CREATE TABLE IF NOT EXISTS core_instructions (
        id int PRIMARY KEY CHECK (id = 1),
        content text NOT NULL CHECK (char_length(content) <= ${LIMITS.coreMaxChars}),
        version int NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `INSERT INTO core_instructions (id, content) VALUES (1, $seed$${CORE_SEED}$seed$) ON CONFLICT (id) DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS core_instructions_history (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        content text NOT NULL,
        version int NOT NULL,
        saved_at timestamptz NOT NULL DEFAULT now()
      )`,
      // Cleanup proposals from a memory scan; nothing in memories changes until the owner approves one on /memory/review.
      `CREATE TABLE IF NOT EXISTS memory_proposals (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        kind text NOT NULL,
        action text NOT NULL,
        memory_ids bigint[] NOT NULL,
        final_text text,
        reason text NOT NULL,
        sources jsonb NOT NULL,
        new_words text[] NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'pending',
        result_id bigint,
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz
      )`,
      // The memories an approved proposal replaced, exactly as they were, so the approval can be undone. A separate
      // table keeps them out of search, dedup and limits without a filter on every query.
      `CREATE TABLE IF NOT EXISTS memory_archive (
        id bigint PRIMARY KEY,
        proposal_id bigint NOT NULL,
        kept boolean NOT NULL,
        content text NOT NULL,
        folded text NOT NULL,
        hash text NOT NULL,
        tags text[] NOT NULL,
        occurred_at timestamptz NOT NULL,
        date_only boolean NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        archived_at timestamptz NOT NULL DEFAULT now()
      )`,
    ]);
  }

  /**
   * Hot paths (search, Core instructions) ask the database first and only create the schema when the query says
   * it is missing: a cold start costs one round trip, not three.
   */
  async function withSchema<T>(run: () => Promise<T>): Promise<{ value: T; retried: boolean }> {
    try {
      return { value: await run(), retried: false };
    } catch (error) {
      if (!isMissingSchema(error)) throw error;
      await ensureSchema();
      return { value: await run(), retried: true };
    }
  }

  async function readCore(): Promise<CoreInstructions> {
    const [record] = await sql.query("SELECT content, version, updated_at FROM core_instructions WHERE id = 1");
    return record ? coreRow(record) : { content: "", version: 0, updatedAt: new Date(0).toISOString() };
  }

  /** One statement, so the update and its history entry land together or not at all (PostgreSQL runs every data-modifying CTE). */
  async function writeCore(content: string, expectedVersion: number): Promise<CoreSaveResult> {
    await ensureSchema();
    const [saved] = await sql.query(
      `WITH old AS (SELECT content, version FROM core_instructions WHERE id = 1 FOR UPDATE),
       upd AS (
         UPDATE core_instructions c SET content = $1, version = old.version + 1, updated_at = now() FROM old
         WHERE c.id = 1 AND old.version = $2 AND old.content <> $1
         RETURNING c.content, c.version, c.updated_at, old.content AS previous, old.version AS previous_version
       ),
       hist AS (INSERT INTO core_instructions_history (content, version) SELECT previous, previous_version FROM upd RETURNING id)
       SELECT content, version, updated_at FROM upd`,
      [content, expectedVersion],
    );
    if (saved) {
      await sql.query(
        "DELETE FROM core_instructions_history WHERE id NOT IN (SELECT id FROM core_instructions_history ORDER BY id DESC LIMIT $1)",
        [LIMITS.coreHistory],
      );
      return { status: "saved", core: coreRow(saved) };
    }
    const current = await readCore();
    if (current.version !== expectedVersion) return { status: "conflict", core: current };
    return { status: "unchanged", core: current };
  }

  async function similar(folded: string, excludeId?: number) {
    const rows = await sql.query(
      `SELECT ${COLUMNS}, similarity(folded, $1) AS score FROM memories
       WHERE similarity(folded, $1) >= $2 AND ($3::bigint IS NULL OR id <> $3)
       ORDER BY score DESC, id DESC LIMIT 3`,
      [folded, LIMITS.similarity, excludeId ?? null],
    );
    return rows.map((record) => ({ ...row(record), similarity: Math.round(Number(record.score) * 100) / 100 }));
  }

  /**
   * Memories on the same subject as a text that trigram similarity is too strict to catch (a later decision about the
   * same thing, worded differently): those sharing at least three of its distinctive words. A word is distinctive
   * when few memories hold it, so "Nick" or "uses" never count.
   */
  async function related(folded: string, excludeId: number): Promise<Memory[]> {
    const words = [...new Set(folded.match(/[a-z0-9]{4,}/g) ?? [])].filter((word) => !STOP_WORDS.has(word)).slice(0, 40);
    if (words.length < RELATED_WORDS) return [];
    const rows = await sql.query(
      `WITH hits AS (SELECT m.id, w.word FROM memories m JOIN unnest($1::text[]) AS w(word) ON strpos(m.folded, w.word) > 0 WHERE m.id <> $2),
       rare AS (SELECT word FROM hits GROUP BY word HAVING count(*) <= greatest(6, (SELECT count(*) FROM memories) / 20)),
       scored AS (SELECT id, count(*) AS shared FROM hits WHERE word IN (SELECT word FROM rare) GROUP BY id HAVING count(*) >= $3)
       SELECT ${COLUMNS.split(", ").map((column) => "m." + column).join(", ")} FROM scored JOIN memories m USING (id)
       ORDER BY scored.shared DESC, m.occurred_at DESC LIMIT 3`,
      [words, excludeId, RELATED_WORDS],
    );
    return rows.map(row);
  }

  async function capacity(pending = 0): Promise<string | undefined> {
    const [counts] = await sql.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - make_interval(mins => $1))::int AS recent FROM memories`,
      [LIMITS.rateMinutes],
    );
    counts.total += pending; counts.recent += pending;
    if (counts.total >= LIMITS.maxMemories) return `Memory is full (${LIMITS.maxMemories} memories). Delete or merge old memories with memory_delete / memory_update first.`;
    if (counts.recent >= LIMITS.rateCount) return `Too many new memories (${LIMITS.rateCount} in ${LIMITS.rateMinutes} minutes). Wait a few minutes; if this is a loop, stop saving.`;
  }

  return {
    async save(items, { dryRun = false } = {}) {
      if (!items.length) throw new MemoryInputError("Nothing to save.");
      if (items.length > LIMITS.maxBatch) throw new MemoryInputError(`At most ${LIMITS.maxBatch} memories per call.`);
      await ensureSchema();
      const results: SaveResult[] = [];
      // Dry run: memories this call would already have written, so later items are checked against them too.
      const pending: { content: string; hash: string; folded: string }[] = [];
      for (const item of items) {
        let content: string, tags: string[], date: string | null;
        try {
          content = cleanContent(item.content); tags = cleanTags(item.tags); date = cleanDate(item.date);
          content = withoutTimelineDate(content, date);
        } catch (error) {
          if (!(error instanceof MemoryInputError)) throw error;
          results.push({ status: "rejected", content: item.content.slice(0, 200), reason: error.message });
          continue;
        }
        const hash = contentHash(content), folded = fold(content);
        const [existing] = await sql.query(`SELECT ${COLUMNS} FROM memories WHERE hash = $1`, [hash]);
        if (existing) { results.push({ status: "duplicate", memory: row(existing) }); continue; }
        const twin = pending.find((earlier) => earlier.hash === hash);
        if (twin) { results.push({ status: "duplicate_in_batch", content, earlier: twin.content }); continue; }
        if (!item.force) {
          const candidates = await similar(folded);
          if (candidates.length) { results.push({ status: "similar", content, candidates }); continue; }
          if (pending.length) {
            const [close] = await sql.query(
              "SELECT i::int AS i, similarity($1, t) AS score FROM unnest($2::text[]) WITH ORDINALITY AS u(t, i) WHERE similarity($1, t) >= $3 ORDER BY score DESC LIMIT 1",
              [folded, pending.map((earlier) => earlier.folded), LIMITS.similarity],
            );
            if (close) { results.push({ status: "similar_in_batch", content, earlier: pending[close.i - 1].content, similarity: Math.round(Number(close.score) * 100) / 100 }); continue; }
          }
        }
        const full = await capacity(pending.length);
        if (full) { results.push({ status: "rejected", content: content.slice(0, 200), reason: full }); continue; }
        if (dryRun) {
          pending.push({ content, hash, folded });
          results.push({ status: "would_save", content, tags, date: date?.slice(0, 10) ?? null });
          continue;
        }
        const [inserted] = await sql.query(
          `INSERT INTO memories (content, folded, hash, tags, occurred_at, date_only)
           VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $5::timestamptz IS NOT NULL)
           ON CONFLICT (hash) DO NOTHING RETURNING ${COLUMNS}`,
          [content, folded, hash, tags, date],
        );
        if (inserted) results.push({ status: "saved", memory: row(inserted), related: await related(folded, Number(inserted.id)) });
        else {
          const [raced] = await sql.query(`SELECT ${COLUMNS} FROM memories WHERE hash = $1`, [hash]);
          results.push({ status: "duplicate", memory: row(raced) });
        }
      }
      return results;
    },

    async update(id, patch) {
      await ensureSchema();
      const [current] = await sql.query(`SELECT ${COLUMNS} FROM memories WHERE id = $1`, [id]);
      if (!current) return { status: "not_found" };
      let content: string, tags: string[], date: string | null;
      try {
        date = cleanDate(patch.date);
        content = patch.content === undefined ? current.content : cleanContent(patch.content);
        content = withoutTimelineDate(content, date ?? (current.date_only ? iso(current.occurred_at) : null));
        tags = patch.tags === undefined ? current.tags : cleanTags(patch.tags);
      } catch (error) {
        if (error instanceof MemoryInputError) return { status: "rejected", reason: error.message };
        throw error;
      }
      const hash = contentHash(content);
      const [clash] = await sql.query(`SELECT ${COLUMNS} FROM memories WHERE hash = $1 AND id <> $2`, [hash, id]);
      if (clash) return { status: "duplicate", memory: row(clash) };
      // updated_at records real changes only.
      const changed = content !== current.content || tags.join("\n") !== (current.tags ?? []).join("\n")
        || (date !== null && (date !== iso(current.occurred_at) || !current.date_only));
      const [updated] = await sql.query(
        `UPDATE memories SET content = $2, folded = $3, hash = $4, tags = $5,
           updated_at = CASE WHEN $7::boolean THEN now() ELSE updated_at END,
           occurred_at = coalesce($6::timestamptz, occurred_at), date_only = ($6::timestamptz IS NOT NULL OR date_only)
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, content, fold(content), hash, tags, date, changed],
      );
      return updated ? { status: "updated", memory: row(updated) } : { status: "not_found" };
    },

    async remove(ids) {
      const list = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
      if (!list.length) return [];
      await ensureSchema();
      const rows = await sql.query("DELETE FROM memories WHERE id = ANY($1::bigint[]) RETURNING id", [list]);
      return rows.map((record) => Number(record.id)).sort((a, b) => a - b);
    },

    async search({ query, limit = 10 }) {
      const text = fold(query);
      if (!text) return [];
      const params: unknown[] = [text];
      const words = wordScore(query, params);
      const where = `(${words} > 0 OR word_similarity($1, folded) >= 0.5)`;
      params.push(Math.min(Math.max(limit, 1), 50));
      const run = () => sql.query(
        `SELECT ${COLUMNS}, ${words} + word_similarity($1, folded) AS score
         FROM memories WHERE ${where} ORDER BY score DESC, occurred_at DESC LIMIT $${params.length}`,
        params,
      );
      // Search is the hot path: every conversation starts with one.
      const started = Date.now();
      const { value: rows, retried } = await withSchema(run);
      onTiming({ step: "search", ms: Date.now() - started, retried, results: rows.length });
      return rows.map((record) => ({ ...row(record), score: Math.round(Number(record.score) * 100) / 100 }));
    },

    async facets(filter = {}) {
      await ensureSchema();
      const base: MemoryFilter = { ...filter, year: undefined };
      const run = async (without: Partial<MemoryFilter>, select: string, order: string) => {
        const params: unknown[] = [];
        const where = filterConditions({ ...base, ...without }, params);
        // Only the year facet needs the time zone; an unused parameter is an error in PostgreSQL.
        if (select.includes("$TZ")) {
          params.push(cleanTimeZone(filter.timeZone));
          select = select.replaceAll("$TZ", `$${params.length}`);
        }
        return sql.query(
          `SELECT ${select}, count(*)::int AS count FROM memories ${where.length ? "WHERE " + where.join(" AND ") : ""}
           GROUP BY 1 ${order}`,
          params,
        );
      };
      const years = await run({}, "extract(year FROM occurred_at AT TIME ZONE $TZ)::int AS year", "ORDER BY 1 DESC");
      return { years: years.map((r) => ({ year: r.year, count: r.count })) };
    },

    async list(options = {}) {
      await ensureSchema();
      const params: unknown[] = [];
      const where = filterConditions(options, params);
      const cursor = decodeCursor(options.cursor);
      if (cursor) { params.push(cursor[0], cursor[1]); where.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`); }
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      params.push(limit + 1);
      const rows = await sql.query(
        `SELECT ${COLUMNS} FROM memories ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY occurred_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      const items = rows.slice(0, limit).map(row);
      return { items, next: rows.length > limit ? encodeCursor(items.at(-1)!) : null };
    },

    async stats(timeZone) {
      await ensureSchema();
      const [totals] = await sql.query(
        `SELECT count(*)::int AS total, coalesce(sum(octet_length(content)), 0)::bigint AS bytes,
           pg_database_size(current_database())::bigint AS database_bytes, pg_total_relation_size('memories')::bigint AS table_bytes FROM memories`,
      );
      const years = await sql.query(
        "SELECT extract(year FROM occurred_at AT TIME ZONE $1)::int AS year, count(*)::int AS count FROM memories GROUP BY 1 ORDER BY 1 DESC",
        [cleanTimeZone(timeZone)],
      );
      return {
        total: totals.total, bytes: Number(totals.bytes),
        storage: { databaseBytes: Number(totals.database_bytes), tableBytes: Number(totals.table_bytes), quotaBytes: storageQuotaBytes() },
        years: years.map((r) => ({ year: r.year, count: r.count })),
        limits: LIMITS,
      };
    },

    async core() {
      const started = Date.now();
      const { value, retried } = await withSchema(readCore);
      onTiming({ step: "core", ms: Date.now() - started, retried });
      return value;
    },

    async saveCore(content, expectedVersion) {
      return writeCore(cleanCoreContent(content), expectedVersion);
    },

    async coreHistory() {
      await ensureSchema();
      const rows = await sql.query("SELECT id, content, version, saved_at FROM core_instructions_history ORDER BY id DESC LIMIT $1", [LIMITS.coreHistory]);
      return rows.map((r) => ({ id: Number(r.id), content: r.content, version: Number(r.version), savedAt: iso(r.saved_at) }));
    },

    async restoreCore(id, expectedVersion) {
      await ensureSchema();
      const [earlier] = await sql.query("SELECT content FROM core_instructions_history WHERE id = $1", [id]);
      if (!earlier) return { status: "not_found" };
      return writeCore(cleanCoreContent(earlier.content), expectedVersion);
    },

    ...consolidation(sql, ensureSchema),
  };
}

let cached: { url: string; store: MemoryStore } | undefined;

/** Production store. Uses its own database (MEMORY_DATABASE_URL) so a full memory table cannot affect anything else in a shared Neon project. */
export function neonMemoryStore(): MemoryStore {
  const url = process.env.MEMORY_DATABASE_URL;
  if (!url) throw new Error("Memory storage unavailable");
  if (!cached || cached.url !== url) {
    const sql = neon(url);
    cached = {
      url,
      store: createMemoryStore({
        query: (text, params = []) => sql.query(text, params) as Promise<Record<string, any>[]>,
        transaction: async (statements) => { await sql.transaction(statements.map((text) => sql.query(text))); },
      }, (event) => console.log(JSON.stringify({ memory: event }))),
    };
  }
  return cached.store;
}
