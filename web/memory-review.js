// Memory review: cleanup proposals from a memory scan. An AI client groups memories that cover the same subject and
// proposes one memory to remain; this page shows each group before and after, and nothing changes until the owner
// approves. Approved cleanups stay listed so they can be undone.
const root = document.getElementById('memory-review');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
// busy: the proposal a decision is being sent for. editing: the proposal whose final text is open, with the draft.
const state = { pending: [], approved: [], loaded: false, error: '', busy: null, editing: null, cardError: null, approvedOpen: false };

const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') el.textContent = value;
    else if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
};
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// Date-only memories are stored at noon UTC on their day: show the day, in UTC, without a time.
const dayFormat = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone });
const when = item => (item.dateOnly ? dayFormat : timeFormat).format(new Date(item.occurredAt));

const KINDS = { duplicate: 'Duplicate', superseded: 'Superseded', conflict: 'Conflict' };
const ACTIONS = { merge: 'Merge into one memory', keep_newest: 'Keep the newest, archive the rest', ask: 'They disagree: your call' };

function announce(message) {
  const status = document.getElementById('review-status');
  if (status) status.textContent = message;
}

async function request(init) {
  const response = await fetch(init ? '/memory/api' : '/memory/api?review=1', init ?? { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && root.dataset.login) { location.href = root.dataset.login + '?next=/memory/review'; return null; }
  // Refusals come with the current lists, so the page never shows a proposal that is gone.
  if (body.pending) Object.assign(state, { pending: body.pending, approved: body.approved });
  if (!response.ok) throw new Error(body.error || 'The request failed. Nothing was changed.');
  return body;
}

async function load() {
  state.error = '';
  try {
    if (await request() === null) return;
  } catch (error) {
    state.error = error.message;
  }
  state.loaded = true;
  render();
}

const DONE = { approve: 'Approved. The replaced memories are archived.', reject: 'Rejected. This group will not be proposed again.', undo: 'Undone. The memories are back as they were.' };

async function decide(proposal, decision, text) {
  state.busy = { id: proposal.id, decision }; state.cardError = null;
  render();
  try {
    const body = await request({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ proposal: proposal.id, decision, ...(text === undefined ? {} : { text }) }) });
    if (body === null) return;
    state.editing = null;
    announce(DONE[decision]);
  } catch (error) {
    // The card may be gone (a stale proposal is dropped): then the message goes above the list.
    const still = [...state.pending, ...state.approved].some(item => item.id === proposal.id);
    if (still) state.cardError = { id: proposal.id, message: error.message }; else state.error = error.message;
  }
  state.busy = null;
  render();
  (document.querySelector('.mem-proposal button:not(:disabled)') ?? document.querySelector('.mem-review-back'))?.focus({ preventScroll: true });
}

function memoryItem(item, stays) {
  return h('li', { class: 'mem-review-item' },
    h('div', { class: 'mem-review-meta' }, h('span', { text: '#' + item.id }), h('time', { datetime: item.occurredAt, text: when(item) }), stays && h('span', { class: 'mem-review-stays', text: 'stays' })),
    h('p', { text: item.content }),
    item.tags.length > 0 && h('div', { class: 'mem-meta' }, item.tags.map(tag => h('span', { class: 'mem-tag', text: '#' + tag }))));
}

function after(proposal, editing) {
  const label = `Final memory for proposal ${proposal.id}`;
  const body = editing
    ? h('textarea', { id: 'review-editor', class: 'mem-review-editor', 'aria-label': label, oninput: e => { state.editing.text = e.target.value; } })
    : proposal.finalText ? h('p', { class: 'mem-review-final', text: proposal.finalText })
      : h('p', { class: 'mem-review-open', text: 'No final text proposed. Choose Edit to write the memory that should remain.' });
  if (editing) body.value = state.editing.text;
  return h('section', { class: 'mem-review-side mem-review-after', 'aria-label': 'After' },
    h('h3', {}, 'After', h('span', { text: '1 memory' })),
    h('div', { class: 'mem-review-item' },
      h('div', { class: 'mem-review-meta' }, h('time', { datetime: proposal.occurredAt, text: when(proposal) }), h('span', { text: 'newest date kept' })),
      body,
      proposal.tags.length > 0 && h('div', { class: 'mem-meta' }, proposal.tags.map(tag => h('span', { class: 'mem-tag', text: '#' + tag })))),
    !editing && proposal.newWords.length > 0 && h('p', { class: 'mem-review-note' }, h('strong', { text: 'Check: ' }), `not found in the memories on the left: ${proposal.newWords.join(', ')}.`));
}

function proposalCard(proposal) {
  const busy = state.busy?.id === proposal.id ? state.busy.decision : null;
  const locked = Boolean(state.busy);
  const editing = state.editing?.id === proposal.id;
  const error = state.cardError?.id === proposal.id ? state.cardError.message : '';
  const startEdit = () => { state.editing = { id: proposal.id, text: proposal.finalText ?? '' }; state.cardError = null; render(); document.getElementById('review-editor')?.focus(); };
  const actions = editing
    ? [h('button', { type: 'button', class: 'mem-button', text: 'Cancel', disabled: locked, onclick: () => { state.editing = null; render(); } }),
       h('button', { type: 'button', class: 'hub-copy', text: busy === 'approve' ? 'Approving…' : 'Save and approve', disabled: locked, onclick: () => decide(proposal, 'approve', state.editing.text) })]
    : [h('button', { type: 'button', class: 'mem-button', text: busy === 'reject' ? 'Rejecting…' : 'Reject', disabled: locked, onclick: () => decide(proposal, 'reject') }),
       h('button', { type: 'button', class: 'mem-button', text: 'Edit', disabled: locked, onclick: startEdit }),
       h('button', { type: 'button', class: 'hub-copy', text: busy === 'approve' ? 'Approving…' : 'Approve', disabled: locked || !proposal.finalText, title: proposal.finalText ? null : 'Write the final memory first (Edit)', onclick: () => decide(proposal, 'approve') })];
  return h('li', { class: 'mem-proposal glass', 'data-id': String(proposal.id), 'aria-busy': busy ? 'true' : null },
    h('header', { class: 'mem-proposal-head' },
      h('span', { class: 'mem-kind ' + proposal.kind, text: KINDS[proposal.kind] ?? proposal.kind }),
      h('span', { class: 'mem-proposal-action', text: ACTIONS[proposal.action] ?? proposal.action }),
      h('p', { text: proposal.reason })),
    h('div', { class: 'mem-review-compare' },
      h('section', { class: 'mem-review-side', 'aria-label': 'Before' },
        h('h3', {}, 'Before', h('span', { text: plural(proposal.sources.length, 'memory', 'memories') })),
        h('ol', {}, proposal.sources.map(source => memoryItem(source, !editing && source.content === proposal.finalText)))),
      after(proposal, editing)),
    h('footer', { class: 'mem-proposal-foot' },
      error && h('span', { class: 'mem-error', role: 'alert', text: error }),
      h('div', { class: 'mem-proposal-actions' }, actions)));
}

// Approved cleanups, newest first. Undo puts every replaced memory back with its id and returns the proposal to the queue.
function approvedList() {
  if (!state.approved.length) return null;
  return h('details', { class: 'mem-review-approved', open: state.approvedOpen, ontoggle: e => { state.approvedOpen = e.target.open; } },
    h('summary', { text: `Approved (${state.approved.length})` }),
    h('ol', {}, state.approved.map(proposal => {
      const busy = state.busy?.id === proposal.id;
      const error = state.cardError?.id === proposal.id ? state.cardError.message : '';
      return h('li', { class: 'mem-approved', 'data-id': String(proposal.id) },
        h('div', { class: 'mem-approved-head' },
          h('span', { class: 'mem-kind ' + proposal.kind, text: KINDS[proposal.kind] ?? proposal.kind }),
          h('span', { text: `${plural(proposal.sources.length, 'memory', 'memories')} → #${proposal.resultId} · ${timeFormat.format(new Date(proposal.decidedAt))}` }),
          h('button', { type: 'button', class: 'mem-button', text: busy ? 'Undoing…' : 'Undo', disabled: Boolean(state.busy), onclick: () => decide(proposal, 'undo') })),
        error && h('p', { class: 'mem-error', role: 'alert', text: error }),
        h('p', { class: 'mem-review-final', text: proposal.finalText }),
        h('details', { class: 'mem-approved-sources' }, h('summary', { text: 'Archived memories' }), h('ol', {}, proposal.sources.map(source => memoryItem(source)))));
    })));
}

function skeleton() {
  const card = () => h('div', { class: 'mem-proposal glass' },
    h('i', { class: 'sk sk-month' }), h('i', { class: 'sk sk-line' }),
    h('div', { class: 'mem-review-compare' }, h('div', {}, h('i', { class: 'sk sk-line' }), h('i', { class: 'sk sk-line sk-short' }), h('i', { class: 'sk sk-line' })), h('div', {}, h('i', { class: 'sk sk-line' }), h('i', { class: 'sk sk-line sk-shorter' }))));
  return h('div', { class: 'mem-proposals mem-skeleton', role: 'status', 'aria-label': 'Loading proposals', 'aria-busy': 'true' }, h('div', { class: 'mem-proposals', 'aria-hidden': 'true' }, card(), card()));
}

function render() {
  const focusedId = document.activeElement?.id;
  const caret = focusedId === 'review-editor' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const status = document.getElementById('review-status')?.textContent ?? '';
  const body = [
    h('section', { class: 'mem-review-heading' },
      h('a', { class: 'mem-review-back text-button', href: '/memory', text: '← Memory' }),
      h('p', { class: 'eyebrow' }, h('span', { class: 'status-dot' }), 'MEMORY REVIEW'),
      h('h1', {}, 'One fact, ', h('em', { text: 'one memory.' })),
      h('p', { class: 'intro-copy', text: 'An AI client groups memories that repeat or replace each other and proposes the one that should remain. Nothing changes until you approve, and every approval can be undone.' }),
      document.getElementById('memory-scan-help') && h('p', { class: 'mem-review-how' }, h('strong', { text: 'To scan: ' }), document.getElementById('memory-scan-help').content.cloneNode(true)),
      state.loaded && !state.error && h('p', { class: 'mem-count' }, plural(state.pending.length, 'PROPOSAL', 'PROPOSALS') + ' WAITING')),
    h('p', { id: 'review-status', class: 'sr-only', role: 'status', 'aria-live': 'polite', text: status }),
  ];
  if (state.error) body.push(h('div', { class: 'mem-empty glass', role: 'alert' }, h('h2', { text: state.loaded && state.pending.length ? 'That did not go through.' : 'Something went wrong.' }), h('p', { text: state.error }),
    h('button', { type: 'button', class: 'text-button', text: 'Reload ↻', onclick: () => { state.loaded = false; render(); load(); } })));
  if (!state.loaded) body.push(skeleton());
  else if (state.pending.length) body.push(h('ol', { class: 'mem-proposals' }, state.pending.map(proposalCard)));
  else if (!state.error) body.push(h('div', { class: 'mem-empty glass' }, h('h2', { text: 'Nothing to review.' }), h('p', { text: 'No cleanup proposals are waiting. Run a scan after a busy week, or when a search returns memories that repeat each other.' })));
  if (state.loaded) body.push(approvedList());
  root.replaceChildren(...body.filter(Boolean));
  const refocus = focusedId && document.getElementById(focusedId);
  if (refocus && refocus !== document.activeElement) { refocus.focus({ preventScroll: true }); if (caret) refocus.setSelectionRange(caret[0], caret[1]); }
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.editing && !state.busy) { state.editing = null; render(); }
});
root.removeAttribute('role');
root.removeAttribute('aria-label');
render();
load();
