// Memory timeline: newest first, grouped by year and month like the FMC timeline. Memories are added only by AI
// clients through MCP; this page reads, searches and deletes them. Above the timeline sit the
// Core instructions: the owner's own text, which every agent gets first from memory_search and only this page edits.
const root = document.getElementById('memory-app');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const state = { q: '', items: [], next: null, stats: null, review: 0, loading: false, refreshing: false, skeleton: false, error: '', confirming: null, storageOpen: false, activeYear: '', facets: { years: [] } };
// Core instructions: data from GET ?core=1; draft is set while editing.
const core = { data: null, history: [], limit: 4000, draft: null, saving: false, error: '', notice: '', restoring: null, historyOpen: false };
let searchTimer, skeletonTimer, requestId = 0;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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
const svg = (paths, size = 16) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) el.setAttribute(k, v);
  el.innerHTML = paths;
  return el;
};
const icons = {
  trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v6m4-6v6"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
};

// Date-only memories (a day given without a time) are stored at noon UTC on that day: format them in UTC.
const formats = zone => ({
  month: new Intl.DateTimeFormat('en', { month: 'long', timeZone: zone }),
  day: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: zone }),
  time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone }),
  full: new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: zone }),
  fullDay: new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeZone: zone }),
  shortDay: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: zone }),
  parts: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', timeZone: zone }),
});
const local = formats(timeZone), utc = formats('UTC');
// An edited memory sits on the day of its last edit (with a real time), like the server sorts it.
const when = memory => {
  const dayOnly = memory.dateOnly && !memory.edited;
  const date = new Date(memory.edited ? memory.sortAt : memory.occurredAt), f = dayOnly ? utc : local;
  const { year, month } = Object.fromEntries(f.parts.formatToParts(date).map(p => [p.type, p.value]));
  return { dayKey: (dayOnly ? utc.shortDay : local.shortDay).format(date), date, year, month, monthName: f.month.format(date), day: f.day.format(date).replace(',', ''), time: dayOnly ? '' : f.time.format(date), full: dayOnly ? f.fullDay.format(date) : f.full.format(date) };
};
const firstDay = memory => (memory.dateOnly ? utc.shortDay : local.shortDay).format(new Date(memory.occurredAt));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

async function load(more = false) {
  const id = ++requestId;
  state.loading = true; state.error = '';
  clearTimeout(skeletonTimer);
  if (!more) {
    // First load: skeleton right away. Filter change: dim the current timeline, and swap in the skeleton only when
    // the reply takes long enough to notice, so fast replies never flash it.
    state.skeleton = !state.items.length;
    state.refreshing = state.items.length > 0;
    render();
    skeletonTimer = setTimeout(() => { if (id === requestId && state.loading) { state.skeleton = true; render(); } }, 150);
  } else render();
  const params = new URLSearchParams({ tz: timeZone });
  if (state.q) params.set('q', state.q);
  if (more && state.next) params.set('cursor', state.next);
  try {
    const response = await fetch('/memory/api?' + params, { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (id !== requestId) return;
    if (response.status === 401 && root.dataset.login) { location.href = root.dataset.login + '?next=/memory'; return; }
    if (!response.ok) throw new Error(body.error || 'Memories could not be loaded.');
    state.items = more ? [...state.items, ...body.items] : body.items;
    state.next = body.next;
    if (body.stats) state.stats = body.stats;
    if (body.review) state.review = body.review.pending;
    if (body.facets) state.facets = body.facets;
  } catch (error) {
    if (id !== requestId) return;
    state.error = error.message || 'Memories could not be loaded.';
  }
  clearTimeout(skeletonTimer);
  const filterChanged = !more && state.stats !== null && id > 1;
  Object.assign(state, { loading: false, refreshing: false, skeleton: false });
  render();
  // New filter results start from the top: bring the timeline start back into view if the reader had scrolled past it.
  if (filterChanged) {
    const timeline = document.querySelector('.mem-timeline, .mem-empty');
    const top = timeline ? timeline.getBoundingClientRect().top + window.scrollY - navOffset() : 0;
    if (timeline && window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    setActiveYear('');
  }
}

async function loadCore() {
  try {
    const response = await fetch('/memory/api?core=1', { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && root.dataset.login) { location.href = root.dataset.login + '?next=/memory'; return; }
    if (!response.ok) throw new Error(body.error || 'Core instructions could not be loaded.');
    Object.assign(core, { data: body.core, history: body.history, limit: body.limit, error: '' });
  } catch (error) {
    core.error = error.message || 'Core instructions could not be loaded.';
  }
  render();
}

// Save the draft, or restore an earlier version. version guards against overwriting a save made elsewhere.
async function saveCore(payload, done) {
  core.saving = true; core.error = ''; core.notice = '';
  render();
  try {
    const response = await fetch('/memory/api', { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...payload, version: core.data.version }) });
    const body = await response.json().catch(() => ({}));
    if (body.core) Object.assign(core, { data: body.core, history: body.history, limit: body.limit });
    if (!response.ok) throw new Error(body.error || 'Core instructions were not saved.');
    core.draft = null; core.restoring = null;
    core.notice = done;
    announce(done);
  } catch (error) {
    core.error = error.message;
  }
  core.saving = false;
  render();
  document.getElementById(core.draft === null ? 'core-edit' : 'core-editor')?.focus({ preventScroll: true });
}

const shortDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone });

let copyTimer;
async function copyCore(button) {
  const content = core.data?.content ?? '';
  const label = button?.querySelector('span');
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
    } else {
      const field = document.createElement('textarea');
      field.value = content;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.focus();
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      if (!copied) throw new Error('Copy not allowed');
    }
    if (label) label.textContent = 'Copied';
    announce('Core instructions copied.');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      if (label && label.isConnected) label.textContent = 'Copy';
    }, 1500);
  } catch {
    if (label) label.textContent = 'Copy failed';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      if (label && label.isConnected) label.textContent = 'Copy';
    }, 1500);
  }
}

function coreCard() {
  // Shaped like the card (eyebrow, intro, text block), so the timeline below does not jump when it arrives.
  if (!core.data && !core.error) return h('section', { class: 'hub-instructions mem-core', role: 'status', 'aria-busy': 'true', 'aria-label': 'Loading Core instructions' },
    h('div', { class: 'mem-core-sk', 'aria-hidden': 'true' }, h('i', { class: 'sk sk-month' }), h('i', { class: 'sk sk-line' }), h('i', { class: 'sk sk-block' })));
  const editing = core.draft !== null;
  const length = (editing ? core.draft : core.data?.content ?? '').length;
  const over = length > core.limit;
  const counter = h('span', { id: 'core-count', class: 'mem-core-count' + (over ? ' over' : ''), text: `${length.toLocaleString('en')} / ${core.limit.toLocaleString('en')} characters` });
  // Core instructions share the same panel primitives as the timeline.
  const head = h('div', { class: 'hub-instructions-head' },
    h('div', {},
      h('p', { class: 'eyebrow', text: 'ALWAYS ON' }),
      h('h3', { text: 'Core instructions' }),
      h('p', { text: 'Every AI client gets these first from memory_search, above any memory. Your words in a chat override them; they override skills and memories. Only this page can change them.' })),
    !editing && core.data && h('div', { class: 'mem-core-actions' },
      h('button', { type: 'button', id: 'core-copy', class: 'hub-copy', onclick: e => copyCore(e.currentTarget) }, svg(icons.copy, 14), h('span', { text: 'Copy' })),
      h('button', { type: 'button', id: 'core-edit', class: 'hub-copy', onclick: () => { core.draft = core.data.content; core.notice = ''; core.error = ''; render(); document.getElementById('core-editor')?.focus(); } }, svg(icons.pencil, 14), h('span', { text: 'Edit' }))));
  if (!core.data) return h('section', { class: 'hub-instructions mem-core', 'aria-label': 'Core instructions' }, head, h('p', { class: 'mem-error', role: 'alert', text: core.error }),
    h('button', { type: 'button', class: 'text-button', text: 'Try again ↻', onclick: () => { core.error = ''; render(); loadCore(); } }));
  const body = editing
    ? h('textarea', { id: 'core-editor', class: 'mem-core-editor', 'aria-label': 'Core instructions', 'aria-describedby': 'core-count', spellcheck: 'false',
        oninput: e => { core.draft = e.target.value; const n = core.draft.length; counter.textContent = `${n.toLocaleString('en')} / ${core.limit.toLocaleString('en')} characters`; counter.classList.toggle('over', n > core.limit); save.disabled = core.saving || n > core.limit; } })
    : core.data.content ? h('pre', { class: 'mem-core-text', 'data-scroll-region': '', tabindex: '0', 'aria-label': 'Core instructions text', text: core.data.content }) : h('p', { class: 'mem-core-empty', text: 'Empty: agents get no Core instructions.' });
  if (editing) body.value = core.draft;
  const save = h('button', { type: 'button', class: 'hub-copy', text: core.saving ? 'Saving…' : 'Save', disabled: core.saving || over, onclick: () => saveCore({ content: core.draft }, 'Core instructions saved.') });
  const foot = h('div', { class: 'hub-instructions-foot mem-core-foot' },
    counter,
    !editing && h('span', { text: `Version ${core.data.version} · updated ${shortDate.format(new Date(core.data.updatedAt))}` }),
    core.notice && h('span', { class: 'mem-core-notice', text: core.notice }),
    core.error && h('span', { class: 'mem-error', role: 'alert', text: core.error }),
    editing && h('div', { class: 'mem-core-actions' },
      h('button', { type: 'button', class: 'mem-button', text: 'Cancel', disabled: core.saving, onclick: () => { core.draft = null; core.error = ''; render(); document.getElementById('core-edit')?.focus(); } }),
      save));
  return h('section', { class: 'hub-instructions mem-core', 'aria-label': 'Core instructions' }, head, body, foot, !editing && coreHistory());
}

// Earlier versions, newest first; restoring one saves it as a new version, so it can be undone the same way.
function coreHistory() {
  if (!core.history.length) return null;
  const details = h('details', { class: 'mem-core-history', open: core.historyOpen, ontoggle: e => { core.historyOpen = e.target.open; } },
    h('summary', { text: `Earlier versions (${core.history.length})` }),
    h('ol', {}, core.history.map(version => h('li', {},
      h('div', { class: 'mem-core-version' },
        h('strong', { text: `Version ${version.version}` }), h('span', { text: shortDate.format(new Date(version.savedAt)) }),
        h('button', { type: 'button', class: 'mem-button', text: core.restoring === version.id && core.saving ? 'Restoring…' : 'Restore', disabled: core.saving,
          onclick: () => { core.restoring = version.id; saveCore({ restore: version.id }, `Version ${version.version} restored.`); } })),
      h('pre', { 'data-scroll-region': '', tabindex: '0', 'aria-label': `Version ${version.version} text`, text: version.content })))));
  return details;
}

async function remove(memory) {
  state.confirming = { id: memory.id, busy: true };
  render();
  try {
    const response = await fetch('/memory/api', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ids: [memory.id] }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'The memory was not deleted.');
    const index = state.items.findIndex(item => item.id === memory.id);
    state.items = state.items.filter(item => item.id !== memory.id);
    if (state.stats) state.stats.total -= 1;
    dropFromFacets(memory);
    state.confirming = null;
    render();
    announce('Memory deleted.');
    const nextRow = document.querySelectorAll('.mem-entry')[Math.min(index, state.items.length - 1)];
    (nextRow?.querySelector('.mem-delete') ?? document.getElementById('memory-search'))?.focus();
  } catch (error) {
    state.confirming = { id: memory.id, error: error.message };
    render();
  }
}

const size = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : bytes < 1024 ** 3 ? `${parseFloat((bytes / 1024 / 1024).toFixed(1))} MB` : `${parseFloat((bytes / 1024 ** 3).toFixed(2))} GB`;

const usage = stats => {
  const percent = Math.min(100, stats.storage.databaseBytes / stats.storage.quotaBytes * 100);
  return { percent, level: percent >= 95 ? ' danger' : percent >= 80 ? ' warn' : '' };
};

// Always visible next to the search, however long the timeline is; amber/red when the database is filling up.
// Details show on hover or keyboard focus (CSS). Touch screens have no hover, so a tap toggles them there.
const touchOnly = () => matchMedia('(hover: none)').matches;
function setStorageOpen(open) {
  state.storageOpen = open;
  render();
  document.querySelector('.mem-storage-chip')?.focus();
}

function storageChip(stats) {
  const { percent, level } = usage(stats);
  const label = level ? `${percent.toFixed(0)}% full` : `${size(stats.storage.databaseBytes)} · ${percent < 0.1 ? '<0.1' : percent.toFixed(1)}%`;
  const wrap = h('div', { class: 'mem-storage-wrap' + (state.storageOpen ? ' open' : ''), onmouseleave: () => wrap.classList.remove('dismissed'), onfocusout: () => wrap.classList.remove('dismissed') },
    h('button', { type: 'button', class: 'mem-storage-chip glass' + level, 'aria-describedby': 'memory-storage',
      'aria-label': `Database storage: ${size(stats.storage.databaseBytes)} of ${size(stats.storage.quotaBytes)} used`,
      onclick: () => { if (touchOnly()) setStorageOpen(!state.storageOpen); } }, svg(icons.database, 14), label),
    storage(stats));
  return wrap;
}

function storage(stats) {
  const { databaseBytes, tableBytes, quotaBytes } = stats.storage;
  const { percent, level } = usage(stats);
  const fill = h('i');
  fill.style.width = Math.max(percent, 1.5) + '%';
  return h('section', { class: 'mem-storage' + level, id: 'memory-storage', 'aria-label': 'Database storage' },
    h('div', { class: 'mem-storage-top' }, h('span', { text: 'Database storage' }), h('strong', { text: `${size(databaseBytes)} of ${size(quotaBytes)}` })),
    h('div', { class: 'mem-meter', role: 'meter', 'aria-label': 'Database storage used', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': percent.toFixed(1), 'aria-valuetext': `${percent.toFixed(1)}% used` }, fill),
    h('p', { text: `${percent < 0.1 ? '<0.1' : percent.toFixed(1)}% used · memories table ${size(tableBytes)}` + (level ? ' · time to clean up' : '') }));
}

function announce(message) {
  const status = document.getElementById('memory-status');
  if (status) status.textContent = message;
}

function heading() {
  const stats = state.stats;
  return h('section', { class: 'mem-heading' },
    h('div', { class: 'mem-heading-copy' },
      h('p', { class: 'eyebrow' }, h('span', { class: 'status-dot' }), 'SHARED MEMORY'),
      h('h1', {}, 'What your AI remembers.', h('br'), h('em', { text: 'All in one place.' })),
      h('p', { class: 'intro-copy', text: 'Every AI client connected to this memory server reads and writes the same memories. Here is the whole story, newest first.' }),
      stats && h('p', { class: 'mem-count' }, plural(stats.total, 'MEMORY', 'MEMORIES'), h('span', { text: '·' }), plural(stats.years.length, 'YEAR', 'YEARS')),
    ),
    h('div', { class: 'mem-thread', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')));
}

const filtered = () => Boolean(state.q);
// A deleted memory left the current view: keep the year counts honest.
function dropFromFacets(memory) {
  const year = Number(when(memory).year);
  state.facets.years = state.facets.years.filter(item => (item.year === year ? --item.count : item.count) > 0);
}
function clearFilters() {
  state.q = '';
  load();
  document.getElementById('memory-search')?.focus({ preventScroll: true });
}

// Sticky year navigation: a pill scrolls the timeline to that year (loading older pages first when needed), and the
// pill of the year in view lights up while scrolling.
function yearNav() {
  const years = state.facets.years;
  if (!years.length) return null;
  const pill = (year, label, count) => h('button', {
    type: 'button', class: 'filter' + (state.activeYear === year ? ' active' : ''), 'data-year': year,
    'aria-current': state.activeYear === year ? 'true' : null, onclick: () => jumpTo(year),
  }, label, h('span', { text: String(count) }));
  return h('nav', { class: 'filters glass mem-yearnav', 'aria-label': 'Jump to year' },
    pill('', 'All', years.reduce((sum, y) => sum + y.count, 0)), years.map(y => pill(String(y.year), String(y.year), y.count)));
}

// Where the bottom of the year navigation sits once it is stuck under the header. Measuring its current position
// instead undershoots every jump while the bar is still in its place in the page.
const navOffset = () => {
  const nav = document.querySelector('.mem-yearnav');
  if (!nav) return 0;
  return (parseFloat(getComputedStyle(nav).top) || 0) + nav.offsetHeight + 12;
};

async function jumpTo(year) {
  let target = year ? document.getElementById('year-' + year) : document.body;
  // Older years may not be loaded yet: fetch further pages until the year shows up or there is nothing left.
  for (let guard = 0; year && !target && state.next && guard < 50; guard++) {
    await load(true);
    target = document.getElementById('year-' + year);
  }
  if (!target) return;
  // "All" goes back to the top of the page; a year lands its heading just under the sticky year navigation.
  const top = year ? target.getBoundingClientRect().top + window.scrollY - navOffset() : 0;
  // The clicked pill stays lit for the whole glide; the scroll-spy takes over again once scrolling stops.
  setActiveYear(year);
  clearTimeout(jumpLock);
  const unlock = () => { clearTimeout(jumpLock); jumpLock = 0; window.removeEventListener('scrollend', unlock); spyFrame ||= requestAnimationFrame(spy); };
  jumpLock = setTimeout(unlock, 1500);
  window.addEventListener('scrollend', unlock, { once: true });
  window.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? 'instant' : 'smooth' });
}

function setActiveYear(year) {
  if (state.activeYear === year) return;
  state.activeYear = year;
  for (const button of document.querySelectorAll('.mem-yearnav [data-year]')) {
    const active = button.dataset.year === year;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    if (active) {
      const nav = button.parentElement;
      const left = button.offsetLeft - nav.clientWidth / 2 + button.offsetWidth / 2;
      if (nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left, behavior: reducedMotion() ? 'instant' : 'smooth' });
    }
  }
}

// Scroll-spy: the active pill is the last year whose section has reached the bottom of the sticky navigation.
let spyFrame = 0;
let jumpLock = 0;
function spy() {
  spyFrame = 0;
  if (jumpLock) return;
  const line = navOffset() + 4;
  let year = '';
  for (const section of document.querySelectorAll('.mem-timeline .mem-year')) {
    if (section.getBoundingClientRect().top <= line) year = section.id.replace('year-', ''); else break;
  }
  setActiveYear(year);
}
window.addEventListener('scroll', () => { spyFrame ||= requestAnimationFrame(spy); }, { passive: true });

// Room after the last loaded year, so a jump can bring even a short final year up under the year navigation
// (otherwise the page bottoms out early and the scroll-spy lights an earlier year).
function fitTail() {
  const timeline = document.querySelector('.mem-timeline:not(.mem-skeleton)');
  const last = timeline?.querySelector('.mem-year:last-of-type');
  if (!last) return;
  timeline.style.paddingBottom = '';
  const needed = last.getBoundingClientRect().top + window.scrollY - navOffset();
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  if (needed > maxScroll) timeline.style.paddingBottom = Math.ceil(needed - maxScroll) + 'px';
}
window.addEventListener('resize', () => { fitTail(); spyFrame ||= requestAnimationFrame(spy); });

function toolbar() {
  const stats = state.stats;
  const search = h('input', { id: 'memory-search', type: 'search', placeholder: 'Search memories', 'aria-label': 'Search memories', autocomplete: 'off',
    oninput: e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250); } });
  search.value = state.q;
  return h('div', { class: 'mem-tools' },
    h('div', { class: 'mem-tools-right' },
      // Cleanup proposals from a memory scan wait on their own page; the count shows when there is something to decide.
      h('a', { class: 'mem-review-link glass', href: '/memory/review' }, 'Review', state.review > 0 && h('span', { 'aria-label': plural(state.review, 'proposal') + ' waiting', text: String(state.review) })),
      h('div', { class: 'mem-tools-end' },
        stats?.storage && storageChip(stats),
        h('label', { class: 'search-field glass' }, svg(icons.search, 15), search, h('kbd', { text: '/' })))));
}

function closeConfirm(id) {
  state.confirming = null;
  render();
  document.querySelector(`[data-id="${id}"] .mem-delete`)?.focus();
}

function entry(memory) {
  const at = when(memory);
  const confirming = state.confirming?.id === memory.id ? state.confirming : null;
  // The trash button keeps its place; the confirmation floats over the row instead of taking layout space.
  const actions = [
    h('button', { type: 'button', class: 'mem-delete', 'aria-label': 'Delete memory', title: 'Delete memory', 'aria-expanded': String(Boolean(confirming)),
      onclick: () => { if (confirming) return closeConfirm(memory.id); state.confirming = { id: memory.id }; render(); document.querySelector(`[data-id="${memory.id}"] .mem-button.danger`)?.focus(); } }, svg(icons.trash)),
    confirming && h('div', { class: 'mem-confirm', role: 'group', 'aria-label': 'Confirm delete' },
      h('span', { text: confirming.error || 'Delete permanently?', class: confirming.error ? 'mem-error' : '' }),
      h('button', { type: 'button', class: 'mem-button', text: 'Cancel', disabled: confirming.busy, onclick: () => closeConfirm(memory.id) }),
      h('button', { type: 'button', class: 'mem-button danger', text: confirming.busy ? 'Deleting…' : 'Delete', disabled: confirming.busy, onclick: () => remove(memory) })),
  ];
  return h('li', { class: 'mem-entry' + (confirming ? ' confirming' : ''), 'data-id': String(memory.id) },
    h('div', { class: 'mem-when' },
      h('time', { datetime: memory.edited ? memory.sortAt : memory.dateOnly ? memory.occurredAt.slice(0, 10) : memory.occurredAt, title: at.full + (memory.dateOnly && !memory.edited ? ' (day only, no time)' : ''), text: at.day }),
      at.time && h('span', { text: at.time })),
    h('div', { class: 'mem-body' },
      h('p', { class: 'mem-content', text: memory.content }),
      (memory.edited || memory.tags.length > 0) && h('div', { class: 'mem-meta' },
        memory.edited && h('span', { class: 'mem-edited', title: 'Edited ' + at.full + '. First dated ' + (memory.dateOnly ? utc.fullDay : local.fullDay).format(new Date(memory.occurredAt)), text: firstDay(memory) === at.dayKey ? 'Updated' : 'Updated · first dated ' + firstDay(memory) }),
        memory.tags.map(tag => h('span', { class: 'mem-tag', text: '#' + tag })))),
    h('div', { class: 'mem-actions' }, actions));
}

function timeline() {
  const years = [];
  for (const memory of state.items) {
    const { year, month, monthName } = when(memory);
    let y = years.at(-1);
    if (y?.year !== year) years.push(y = { year, months: [] });
    let m = y.months.at(-1);
    if (m?.month !== month) y.months.push(m = { month, label: monthName, items: [] });
    m.items.push(memory);
  }
  const yearCount = year => state.facets.years.find(y => String(y.year) === year)?.count;
  return h('div', { class: 'mem-timeline' + (state.refreshing ? ' refreshing' : ''), 'aria-busy': state.refreshing ? 'true' : null }, years.map(({ year, months }) => h('section', { class: 'mem-year', id: 'year-' + year, 'aria-labelledby': 'year-title-' + year },
    h('header', { class: 'mem-year-head' }, h('h2', { id: 'year-title-' + year, text: year }),
      h('span', { text: yearCount(year) ? plural(yearCount(year), 'memory', 'memories') : '' })),
    h('div', { class: 'mem-year-body' }, months.map(({ label, items }) => h('div', { class: 'mem-month' },
      h('h3', { class: 'mem-month-label' }, h('span', { text: label })),
      h('ol', { class: 'mem-entries' }, items.map(entry))))))));
}

// Placeholder shaped like the timeline (year, month, rows), so content lands where the skeleton was.
function skeleton() {
  const row = (wide) => h('li', { class: 'mem-entry' },
    h('div', { class: 'mem-when' }, h('i', { class: 'sk sk-day' }), h('i', { class: 'sk sk-time' })),
    h('div', { class: 'mem-body' }, h('i', { class: 'sk sk-line' + (wide ? '' : ' sk-short') }), h('i', { class: 'sk sk-line sk-shorter' }),
      h('div', { class: 'mem-meta' }, h('i', { class: 'sk sk-chip' }), h('i', { class: 'sk sk-chip' }))));
  return h('div', { class: 'mem-timeline mem-skeleton', role: 'status', 'aria-label': 'Loading memories', 'aria-busy': 'true' },
    h('section', { class: 'mem-year', 'aria-hidden': 'true' },
      h('header', { class: 'mem-year-head' }, h('i', { class: 'sk sk-year' })),
      h('div', { class: 'mem-year-body' }, h('div', { class: 'mem-month' },
        h('div', { class: 'mem-month-label' }, h('i', { class: 'sk sk-month' })),
        h('ol', { class: 'mem-entries' }, row(true), row(false), row(true), row(false))))));
}

function empty() {
  if (filtered()) return h('div', { class: 'mem-empty glass' }, h('h2', { text: 'Nothing here.' }), h('p', { text: 'No memories match this search.' }),
    h('button', { type: 'button', class: 'text-button', text: 'Clear search ↗', onclick: clearFilters }));
  return h('div', { class: 'mem-empty glass' }, h('h2', { text: 'No memories yet.' }),
    h('p', {}, 'Ask any AI client connected to this memory server to remember something.'));
}

function render() {
  // Rendering replaces the DOM: keep focus (and the search caret) on the control that had it.
  const focusedId = document.activeElement?.id;
  const field = ['memory-search', 'core-editor'].includes(focusedId) ? document.activeElement : null;
  const caret = field ? [field.selectionStart, field.selectionEnd, field.scrollTop] : null;
  const status = document.getElementById('memory-status')?.textContent ?? '';
  const body = [heading(), coreCard(), yearNav(), toolbar(), h('p', { id: 'memory-status', class: 'sr-only', role: 'status', 'aria-live': 'polite', text: status })];
  if (state.error) body.push(h('div', { class: 'mem-empty glass', role: 'alert' }, h('h2', { text: 'Something went wrong.' }), h('p', { text: state.error }), h('button', { type: 'button', class: 'text-button', text: 'Try again ↻', onclick: () => load() })));
  else if (state.skeleton) body.push(skeleton());
  else if (!state.items.length) body.push(empty());
  else {
    body.push(timeline());
    if (state.next) body.push(h('div', { class: 'mem-more' }, h('button', { type: 'button', class: 'mem-button', text: state.loading ? 'Loading…' : 'Load older memories', disabled: state.loading, onclick: () => load(true) })));
  }
  root.replaceChildren(...body.filter(Boolean)); // Optional sections are null or false while data loads.
  const refocus = focusedId && document.getElementById(focusedId);
  if (refocus && refocus !== document.activeElement) { refocus.focus({ preventScroll: true }); if (caret) { refocus.setSelectionRange(caret[0], caret[1]); refocus.scrollTop = caret[2]; } }
  fitTail();
  spyFrame ||= requestAnimationFrame(spy);
}

document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { event.preventDefault(); document.getElementById('memory-search')?.focus(); }
  if (event.key === 'Escape' && state.confirming && !state.confirming.busy) closeConfirm(state.confirming.id);
  else if (event.key === 'Escape' && state.storageOpen) setStorageOpen(false);
  else if (event.key === 'Escape') document.querySelector('.mem-storage-wrap')?.classList.add('dismissed');
});
document.addEventListener('pointerdown', event => {
  if (state.storageOpen && !event.target.closest?.('.mem-storage-wrap')) { state.storageOpen = false; render(); }
  if (state.confirming && !state.confirming.busy && !event.target.closest?.('.mem-actions')) { state.confirming = null; render(); }
});
root.removeAttribute('role');
root.removeAttribute('aria-label');
load();
loadCore();
