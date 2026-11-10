import { COLUMNS, MemoryInputError, canonical, cleanContent, contentHash, fold, row, type Memory, type SqlRunner } from "./store.js";

// Memory cleanup. An agent scans the memories and proposes what to do with each group that covers the same subject;
// the owner approves, edits or rejects every proposal on /memory/review. Nothing here changes a memory without that
// approval, and an approval can be undone: the replaced memories wait in memory_archive.

export type ProposalKind = "duplicate" | "superseded" | "conflict";
export type ProposalAction = "merge" | "keep_newest" | "ask";
export type ProposalStatus = "pending" | "approved" | "rejected" | "stale";

/** A memory as it was when the proposal was made: what the review page shows as "before". */
export interface ProposalSource { id: number; content: string; tags: string[]; occurredAt: string; dateOnly: boolean }

export interface Proposal {
  id: number;
  kind: ProposalKind;
  action: ProposalAction;
  memoryIds: number[];
  /** The one memory that should remain. Null when the agent could not settle a conflict: the owner writes it. */
  finalText: string | null;
  reason: string;
  sources: ProposalSource[];
  /** Words of finalText found in none of the sources: a hint that the merge may have added something. */
  newWords: string[];
  /** What the remaining memory gets on approval: every tag of the group and its newest date. */
  tags: string[];
  occurredAt: string;
  dateOnly: boolean;
  status: ProposalStatus;
  resultId: number | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface NewProposal { ids: number[]; kind: ProposalKind; finalText?: string; reason: string }
export type ProposeResult = { status: "proposed"; proposal: Proposal } | { status: "refused"; ids: number[]; reason: string };
export type DecisionResult =
  | { status: "approved"; proposal: Proposal; memory: Memory }
  | { status: "rejected" | "undone"; proposal: Proposal }
  | { status: "not_found" }
  // The memories changed after the scan, so the proposal no longer describes them; it is dropped.
  | { status: "stale" }
  | { status: "refused"; reason: string };

export interface ConsolidationStore {
  propose(items: NewProposal[]): Promise<ProposeResult[]>;
  /** Proposals waiting for the owner, and approved ones (newest first) that can still be undone. */
  proposals(): Promise<{ pending: Proposal[]; approved: Proposal[] }>;
  pendingProposals(): Promise<number>;
  /** text replaces the proposed final text ("edit, then approve"). */
  approveProposal(id: number, text?: string): Promise<DecisionResult>;
  rejectProposal(id: number): Promise<DecisionResult>;
  /** Puts the replaced memories back as they were, with their ids, and the proposal back in the queue. */
  undoProposal(id: number): Promise<DecisionResult>;
}

export const PROPOSAL_LIMITS = { minGroup: 2, maxGroup: 20, maxReason: 300, maxBatch: 25, approvedShown: 50 } as const;

const newestFirst = (a: ProposalSource, b: ProposalSource) => b.occurredAt.localeCompare(a.occurredAt) || b.id - a.id;

/** The group's most recent memory: its date is the one the remaining memory keeps. */
export function newest(sources: ProposalSource[]): ProposalSource {
  return [...sources].sort(newestFirst)[0];
}

/**
 * What approving does, from the agent's classification: a conflict is the owner's call; otherwise the newest memory
 * stays as it is when the final text is its text, and the group is merged into one text when it is not.
 */
export function actionFor(kind: ProposalKind, finalText: string | null, sources: ProposalSource[]): ProposalAction {
  if (kind === "conflict") return "ask";
  return finalText !== null && contentHash(finalText) === contentHash(newest(sources).content) ? "keep_newest" : "merge";
}

/** Every tag of the group, the newest memory's first. */
export function mergedTags(sources: ProposalSource[]): string[] {
  return [...new Set([...sources].sort(newestFirst).flatMap((source) => source.tags))];
}

// Words a merge needs to join facts; they carry no fact of their own.
const GLUE = new Set(["also", "although", "another", "because", "been", "before", "after", "both", "does", "each", "either", "from", "have", "having", "however", "instead", "into", "later", "more", "most", "only", "other", "over", "rather", "same", "since", "some", "such", "than", "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "under", "until", "were", "when", "where", "which", "while", "with", "within", "without", "would"]);

/**
 * A merged memory may only say what its sources say. Code cannot judge meaning, but it can point at words (and
 * numbers) of the final text that appear in no source, for the agent to fix and the owner to check.
 */
export function wordsNotInSources(finalText: string, sources: ProposalSource[]): string[] {
  const known = fold(sources.map((source) => source.content).join(" "));
  const words = fold(finalText).match(/[a-z0-9]+/g) ?? [];
  return [...new Set(words.filter((word) => (word.length >= 4 || /\d/.test(word)) && !GLUE.has(word) && !known.includes(word)))].slice(0, 12);
}

const iso = (value: unknown): string => new Date(value as string).toISOString();
const snapshot = (memory: Memory): ProposalSource => ({ id: memory.id, content: memory.content, tags: memory.tags, occurredAt: memory.occurredAt, dateOnly: memory.dateOnly });
const sameAsSnapshot = (memory: Memory | undefined, source: ProposalSource) => memory !== undefined && memory.content === source.content && memory.tags.join("\n") === source.tags.join("\n");

function proposalRow(record: Record<string, any>): Proposal {
  const sources: ProposalSource[] = typeof record.sources === "string" ? JSON.parse(record.sources) : record.sources;
  const latest = newest(sources);
  return {
    id: Number(record.id), kind: record.kind, action: record.action, memoryIds: (record.memory_ids as unknown[]).map(Number),
    finalText: record.final_text ?? null, reason: record.reason, sources: [...sources].sort(newestFirst), newWords: record.new_words ?? [],
    tags: mergedTags(sources), occurredAt: latest.occurredAt, dateOnly: latest.dateOnly,
    status: record.status, resultId: record.result_id === null ? null : Number(record.result_id),
    createdAt: iso(record.created_at), decidedAt: record.decided_at ? iso(record.decided_at) : null,
  };
}

const PROPOSAL_COLUMNS = "id, kind, action, memory_ids, final_text, reason, sources, new_words, status, result_id, created_at, decided_at";
const validId = (id: number) => Number.isSafeInteger(id) && id > 0;

export function consolidation(sql: SqlRunner, ensureSchema: () => Promise<void>): ConsolidationStore {
  async function current(ids: number[]): Promise<Map<number, Memory>> {
    const rows = await sql.query(`SELECT ${COLUMNS} FROM memories WHERE id = ANY($1::bigint[])`, [ids]);
    return new Map(rows.map((record) => [Number(record.id), row(record)]));
  }

  async function find(id: number): Promise<Proposal | undefined> {
    if (!validId(id)) return undefined;
    const [record] = await sql.query(`SELECT ${PROPOSAL_COLUMNS} FROM memory_proposals WHERE id = $1`, [id]);
    return record && proposalRow(record);
  }

  /** A pending proposal whose memories were edited or deleted since the scan no longer describes them. */
  async function dropIfStale(proposal: Proposal): Promise<boolean> {
    const now = await current(proposal.memoryIds);
    if (proposal.sources.every((source) => sameAsSnapshot(now.get(source.id), source))) return false;
    await sql.query("UPDATE memory_proposals SET status = 'stale', decided_at = now() WHERE id = $1 AND status = 'pending'", [proposal.id]);
    return true;
  }

  /** Another memory already holds this exact text: saving it twice is what the unique index forbids. */
  async function clash(text: string, groupIds: number[]): Promise<number | undefined> {
    const [other] = await sql.query("SELECT id FROM memories WHERE hash = $1 AND NOT (id = ANY($2::bigint[]))", [contentHash(text), groupIds]);
    return other && Number(other.id);
  }

  async function proposeOne(item: NewProposal): Promise<ProposeResult> {
    const ids = [...new Set(item.ids)].filter(validId).sort((a, b) => a - b);
    const refused = (reason: string): ProposeResult => ({ status: "refused", ids, reason });
    if (ids.length < PROPOSAL_LIMITS.minGroup) return refused("A proposal needs at least two different memories.");
    if (ids.length > PROPOSAL_LIMITS.maxGroup) return refused(`At most ${PROPOSAL_LIMITS.maxGroup} memories per proposal; split the group.`);
    if (!["duplicate", "superseded", "conflict"].includes(item.kind)) return refused("kind must be duplicate, superseded or conflict.");
    const reason = canonical(item.reason ?? "");
    if (!reason || reason.length > PROPOSAL_LIMITS.maxReason) return refused(`Give a one-line reason (at most ${PROPOSAL_LIMITS.maxReason} characters).`);

    const memories = await current(ids);
    const missing = ids.filter((id) => !memories.has(id));
    if (missing.length) return refused(`No memory ${missing.map((id) => "#" + id).join(", ")}.`);
    const sources = ids.map((id) => snapshot(memories.get(id)!));

    let finalText: string | null = null;
    if (item.finalText !== undefined && canonical(item.finalText)) {
      try { finalText = cleanContent(item.finalText); } catch (error) {
        if (error instanceof MemoryInputError) return refused(error.message);
        throw error;
      }
    }
    if (finalText === null && item.kind !== "conflict") return refused("final_text is required for a duplicate or superseded group: the one memory that should remain.");
    if (finalText !== null) {
      const other = await clash(finalText, ids);
      if (other) return refused(`final_text is identical to memory #${other}, which is not in the group: add it to the group.`);
    }

    const [waiting] = await sql.query("SELECT id, memory_ids FROM memory_proposals WHERE status = 'pending' AND memory_ids && $1::bigint[] ORDER BY id LIMIT 1", [ids]);
    if (waiting) {
      const shared = (waiting.memory_ids as unknown[]).map(Number).filter((id) => ids.includes(id));
      return refused(`${shared.map((id) => "#" + id).join(", ")} already wait${shared.length === 1 ? "s" : ""} in proposal ${waiting.id} for the owner's decision.`);
    }
    // Rejected groups stay rejected: only a group with a memory the rejected one did not have may be proposed again.
    const [rejected] = await sql.query("SELECT id FROM memory_proposals WHERE status = 'rejected' AND memory_ids @> $1::bigint[] LIMIT 1", [ids]);
    if (rejected) return refused("The owner rejected a cleanup of these memories. Do not propose it again unless a new memory joins the group.");

    const [inserted] = await sql.query(
      `INSERT INTO memory_proposals (kind, action, memory_ids, final_text, reason, sources, new_words)
       VALUES ($1, $2, $3::bigint[], $4, $5, $6::jsonb, $7::text[]) RETURNING ${PROPOSAL_COLUMNS}`,
      [item.kind, actionFor(item.kind, finalText, sources), ids, finalText, reason, JSON.stringify(sources), finalText === null ? [] : wordsNotInSources(finalText, sources)],
    );
    return { status: "proposed", proposal: proposalRow(inserted) };
  }

  return {
    async propose(items) {
      if (!items.length) throw new MemoryInputError("Nothing to propose.");
      if (items.length > PROPOSAL_LIMITS.maxBatch) throw new MemoryInputError(`At most ${PROPOSAL_LIMITS.maxBatch} proposals per call.`);
      await ensureSchema();
      const results: ProposeResult[] = [];
      // One at a time: a later item is checked against the proposals this call has already stored.
      for (const item of items) results.push(await proposeOne(item));
      return results;
    },

    async proposals() {
      await ensureSchema();
      const waiting = (await sql.query(`SELECT ${PROPOSAL_COLUMNS} FROM memory_proposals WHERE status = 'pending' ORDER BY id`)).map(proposalRow);
      const pending: Proposal[] = [];
      for (const proposal of waiting) if (!await dropIfStale(proposal)) pending.push(proposal);
      const approved = await sql.query(`SELECT ${PROPOSAL_COLUMNS} FROM memory_proposals WHERE status = 'approved' ORDER BY decided_at DESC, id DESC LIMIT $1`, [PROPOSAL_LIMITS.approvedShown]);
      return { pending, approved: approved.map(proposalRow) };
    },

    async pendingProposals() {
      await ensureSchema();
      const [counts] = await sql.query("SELECT count(*)::int AS pending FROM memory_proposals WHERE status = 'pending'");
      return counts.pending;
    },

    async approveProposal(id, text) {
      await ensureSchema();
      const proposal = await find(id);
      if (!proposal || proposal.status !== "pending") return { status: "not_found" };
      if (await dropIfStale(proposal)) return { status: "stale" };
      let finalText = proposal.finalText;
      if (text !== undefined) {
        try { finalText = cleanContent(text); } catch (error) {
          if (error instanceof MemoryInputError) return { status: "refused", reason: error.message };
          throw error;
        }
      }
      if (finalText === null) return { status: "refused", reason: "Write the memory that should remain, then approve." };
      const other = await clash(finalText, proposal.memoryIds);
      if (other) return { status: "refused", reason: `Memory #${other} already says exactly this. Reject this proposal, or change the text.` };

      // The memory that stays keeps its id. Normally the newest; if the final text is another member's exact text,
      // that member stays instead, so the unique text index never sees two rows with it. Either way it gets the
      // group's newest date.
      const hash = contentHash(finalText);
      const latest = newest(proposal.sources);
      const target = proposal.sources.find((source) => contentHash(source.content) === hash) ?? latest;
      const [updated] = await sql.query(
        `WITH grp AS (SELECT * FROM memories WHERE id = ANY($1::bigint[]) FOR UPDATE),
         arch AS (
           INSERT INTO memory_archive (id, proposal_id, kept, content, folded, hash, tags, occurred_at, date_only, created_at, updated_at)
           SELECT id, $2, id = $3, content, folded, hash, tags, occurred_at, date_only, created_at, updated_at FROM grp RETURNING id
         ),
         gone AS (DELETE FROM memories WHERE id = ANY($1::bigint[]) AND id <> $3 RETURNING id),
         upd AS (
           UPDATE memories SET content = $4, folded = $5, hash = $6, tags = $7::text[], occurred_at = $8::timestamptz, date_only = $9, updated_at = now()
           WHERE id = $3 AND (SELECT count(*) FROM grp) = $10 RETURNING ${COLUMNS}
         ),
         prop AS (UPDATE memory_proposals SET status = 'approved', final_text = $4, result_id = $3, decided_at = now() WHERE id = $2 AND EXISTS (SELECT 1 FROM upd) RETURNING id)
         SELECT ${COLUMNS} FROM upd`,
        [proposal.memoryIds, id, target.id, finalText, fold(finalText), hash, proposal.tags, latest.occurredAt, latest.dateOnly, proposal.memoryIds.length],
      );
      if (!updated) return { status: "stale" };
      return { status: "approved", proposal: (await find(id))!, memory: row(updated) };
    },

    async rejectProposal(id) {
      await ensureSchema();
      if (!validId(id)) return { status: "not_found" };
      const [record] = await sql.query(`UPDATE memory_proposals SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING ${PROPOSAL_COLUMNS}`, [id]);
      return record ? { status: "rejected", proposal: proposalRow(record) } : { status: "not_found" };
    },

    async undoProposal(id) {
      await ensureSchema();
      const proposal = await find(id);
      if (!proposal || proposal.status !== "approved" || proposal.resultId === null) return { status: "not_found" };
      const [merged] = await sql.query("SELECT content FROM memories WHERE id = $1", [proposal.resultId]);
      // An edit made after the approval would be lost with the merged memory; a deleted one has nothing to lose.
      if (merged && merged.content !== proposal.finalText) return { status: "refused", reason: `Memory #${proposal.resultId} was changed after this approval, so undoing would discard that change. Delete or fix it by hand.` };
      try {
        // Only integers are written into these statements (the runner's transactions take no parameters).
        await sql.transaction([
          `DELETE FROM memories WHERE id = ${proposal.resultId}`,
          `INSERT INTO memories (id, content, folded, hash, tags, occurred_at, date_only, created_at, updated_at) OVERRIDING SYSTEM VALUE
           SELECT id, content, folded, hash, tags, occurred_at, date_only, created_at, updated_at FROM memory_archive WHERE proposal_id = ${proposal.id}`,
          `DELETE FROM memory_archive WHERE proposal_id = ${proposal.id}`,
          `UPDATE memory_proposals SET status = 'pending', result_id = NULL, decided_at = NULL WHERE id = ${proposal.id}`,
        ]);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return { status: "refused", reason: "A memory with the same text as one of the replaced memories was saved since. Delete it first, then undo." };
        throw error;
      }
      return { status: "undone", proposal: (await find(id))! };
    },
  };
}
