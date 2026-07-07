/* Tracker board UI. All user-generated strings are rendered via textContent, never innerHTML. */
(function () {
  'use strict';

  const STATUSES = [
    { key: 'backlog', label: 'Backlog' },
    { key: 'on-deck', label: 'On Deck' },
    { key: 'in-progress', label: 'In Progress' },
    { key: 'in-review', label: 'In Review' },
    { key: 'done', label: 'Done' },
  ];
  const TYPES = ['bug', 'improvement', 'feature', 'other'];
  const POLL_MS = 5000;

  const state = {
    projects: [],
    projectKey: localStorage.getItem('it-project') || null,
    issues: [],
    closed: [],
    icebox: [],
    view: 'board', // board | icebox | archive
    query: '',
    draggingId: null,
    drawerId: null,
    lastSeenAt: 0, // new-since-last-seen watermark; set in boot()
    backlogSort: localStorage.getItem('it-backlog-sort') || 'newest', // newest | oldest
  };

  const $board = document.getElementById('board');
  const $select = document.getElementById('project-select');
  const $count = document.getElementById('issue-count');
  const $search = document.getElementById('search');
  const $drawer = document.getElementById('drawer');
  const $backdrop = document.getElementById('drawer-backdrop');
  const $modalRoot = document.getElementById('modal-root');
  const $viewBoard = document.getElementById('view-board');
  const $viewIcebox = document.getElementById('view-icebox');
  const $viewArchive = document.getElementById('view-archive');

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---- copy-reference button ----------------------------------------------
  // A one-click, agent-recognizable reference to a ticket. Pasting it into a
  // chat with an agent that has the VibeOps MCP server lets it resolve the
  // exact issue via get_issue {id}. "VibeOps" is the grounding word; the
  // <project>-<n> id is what the MCP tools key off.

  function issueRef(issue) {
    const title = (issue.title || '').trim();
    return title ? `VibeOps issue ${issue.id}: "${title}"` : `VibeOps issue ${issue.id}`;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgIcon(children) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({
      viewBox: '0 0 24 24', width: '13', height: '13', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round',
      'stroke-linejoin': 'round', 'aria-hidden': 'true',
    })) svg.setAttribute(k, v);
    for (const c of children) svg.appendChild(c);
    return svg;
  }
  function svgPath(d) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    return p;
  }
  function copyGlyph() {
    const rect = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of Object.entries({ x: '9', y: '9', width: '13', height: '13', rx: '2' })) rect.setAttribute(k, v);
    return svgIcon([rect, svgPath('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')]);
  }
  function checkGlyph() {
    return svgIcon([svgPath('M20 6L9 17l-5-5')]);
  }

  // A tiny copy button that sits next to a ticket id. stopPropagation keeps a
  // click on it from opening the card's drawer / archive row.
  function copyRefBtn(issue) {
    const btn = el('button', 'copy-id');
    btn.type = 'button';
    btn.title = `Copy reference: ${issueRef(issue)}`;
    btn.setAttribute('aria-label', `Copy an agent-ready reference to ${issue.id}`);
    btn.appendChild(copyGlyph());
    let resetT;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      clearTimeout(resetT);
      try {
        await navigator.clipboard.writeText(issueRef(issue));
        btn.classList.remove('failed');
        btn.classList.add('copied');
        btn.replaceChildren(checkGlyph());
      } catch {
        btn.classList.remove('copied');
        btn.classList.add('failed');
      }
      resetT = setTimeout(() => {
        btn.classList.remove('copied', 'failed');
        btn.replaceChildren(copyGlyph());
      }, 1200);
    });
    return btn;
  }

  // ---- severity, activity age, new-marker, sort ---------------------------

  // Signal-strength severity: five ascending bars, lit up to the level. Lives in
  // one fixed spot (far right of the meta row) so severity always reads the same.
  function severityBars(level) {
    const n = Math.max(1, Math.min(5, Number(level) || 3));
    const wrap = el('span', 'sev-bars');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', `Severity ${n} of 5`);
    wrap.title = `Severity ${n}`;
    for (let i = 1; i <= 5; i++) {
      const bar = el('i');
      if (i <= n) bar.style.background = `var(--sev${n})`;
      wrap.appendChild(bar);
    }
    return wrap;
  }

  function lastActivityIso(issue) {
    return issue.lastActivity || issue.updated || issue.created;
  }

  // Aging heat: bright green while fresh, warming to red once a card sits idle.
  // Bucket by whole days so the color matches the day count the card displays
  // (a card reading "2d" is yellow, never the 3-7d amber for being 2d + seconds).
  function heatColor(iso) {
    if (!iso) return 'var(--muted)';
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days < 1) return 'var(--heat-fresh)';
    if (days <= 2) return 'var(--heat-warm)';
    if (days <= 7) return 'var(--heat-amber)';
    return 'var(--heat-stale)';
  }

  // The card's one time: how long since the issue was last worked on.
  function activityAge(issue) {
    const iso = lastActivityIso(issue);
    const span = el('span', 'card-age hot', relAge(iso));
    span.style.color = heatColor(iso);
    span.title = `Last activity ${relAge(iso)} ago`;
    return span;
  }

  // New since the previous visit: created after the stored last-seen watermark.
  function isNew(issue) {
    return !!(state.lastSeenAt && issue.created && new Date(issue.created).getTime() > state.lastSeenAt);
  }

  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  }

  function sortGlyph() {
    // A down arrow that flips (via the .desc CSS) between newest and oldest.
    return svgIcon([svgPath('M12 5v14'), svgPath('m19 12-7 7-7-7')]);
  }

  function sortBacklog(issues) {
    const dir = state.backlogSort === 'oldest' ? 1 : -1;
    return issues.slice().sort((a, b) => (new Date(a.created || 0) - new Date(b.created || 0)) * dir || a.id.localeCompare(b.id));
  }

  function sortToggle() {
    const oldest = state.backlogSort === 'oldest';
    const btn = el('button', 'sort-btn' + (oldest ? ' desc' : ''));
    btn.type = 'button';
    btn.appendChild(sortGlyph());
    btn.appendChild(el('span', 'sort-txt', oldest ? 'Oldest' : 'Newest'));
    btn.title = `Backlog sorted ${oldest ? 'oldest' : 'newest'} first (click to flip)`;
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.backlogSort = oldest ? 'newest' : 'oldest';
      localStorage.setItem('it-backlog-sort', state.backlogSort);
      render();
    });
    return btn;
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
  }

  function relAge(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  function matchesQuery(issue, q) {
    if (!q) return true;
    return [issue.id, issue.title, (issue.tags || []).join(' '), issue.seeing, issue.expecting, issue.resolution || '']
      .join('\n')
      .toLowerCase()
      .includes(q);
  }

  // ---- project switcher ---------------------------------------------------

  async function loadProjects() {
    state.projects = await api('/api/projects');
    $select.replaceChildren();
    for (const p of state.projects) {
      const opt = el('option', null, p.name);
      opt.value = p.key;
      $select.appendChild(opt);
    }
    if (!state.projects.length) {
      state.projectKey = null;
    } else if (!state.projects.some((p) => p.key === state.projectKey)) {
      state.projectKey = state.projects[0].key;
    }
    if (state.projectKey) $select.value = state.projectKey;
  }

  $select.addEventListener('change', () => {
    state.projectKey = $select.value;
    localStorage.setItem('it-project', state.projectKey);
    refresh();
  });

  $search.addEventListener('input', () => {
    state.query = $search.value.trim().toLowerCase();
    render();
  });

  $viewBoard.addEventListener('click', () => setView('board'));
  $viewIcebox.addEventListener('click', () => setView('icebox'));
  $viewArchive.addEventListener('click', () => setView('archive'));

  function setView(view) {
    state.view = view;
    $viewBoard.classList.toggle('on', view === 'board');
    $viewIcebox.classList.toggle('on', view === 'icebox');
    $viewArchive.classList.toggle('on', view === 'archive');
    refresh();
  }

  // ---- data + render ------------------------------------------------------

  async function refresh() {
    if (!state.projectKey) {
      renderEmptyHint();
      return;
    }
    if (state.view === 'board') {
      state.issues = await api(`/api/projects/${encodeURIComponent(state.projectKey)}/issues`);
    } else if (state.view === 'icebox') {
      state.icebox = await api(`/api/projects/${encodeURIComponent(state.projectKey)}/icebox`);
    } else {
      state.closed = await api(`/api/projects/${encodeURIComponent(state.projectKey)}/closed`);
    }
    render();
  }

  function render() {
    if (!state.projectKey) {
      renderEmptyHint();
      return;
    }
    if (state.view === 'board') renderBoard();
    else if (state.view === 'icebox') renderIcebox();
    else renderArchive();
  }

  function renderEmptyHint() {
    $count.textContent = '';
    $board.replaceChildren();
    const hint = el('div', 'hint');
    hint.appendChild(el('p', null, 'No projects yet. Install the widget in any of your apps and capture your first issue:'));
    const code = el('code', null, `<script src="${location.origin}/widget.js" data-project="my-project" defer><\/script>`);
    hint.appendChild(code);
    const more = el('p', null, 'Or create one right here with “+ New issue” after registering a project, or see Help for the full guide.');
    hint.appendChild(more);
    $board.appendChild(hint);
  }

  function renderBoard() {
    if (state.draggingId) return; // never re-render mid-drag
    const visible = state.issues.filter((i) => matchesQuery(i, state.query));
    // Preserve each column's scroll position across the re-render. The 5s poll
    // re-renders the board, which would otherwise snap a scrolled column to top.
    const scrolls = {};
    $board.querySelectorAll('.col-cards').forEach((c) => { scrolls[c.dataset.status] = c.scrollTop; });
    $count.textContent = state.query
      ? `${visible.length} of ${state.issues.length} issue${state.issues.length === 1 ? '' : 's'}`
      : `${state.issues.length} issue${state.issues.length === 1 ? '' : 's'}`;
    $board.className = '';
    $board.replaceChildren();
    for (const status of STATUSES) {
      let issues = visible.filter((i) => i.status === status.key);
      if (status.key === 'backlog') issues = sortBacklog(issues); // created newest/oldest, persisted
      const col = el('div', 'col');
      const head = el('div', 'col-head');
      head.appendChild(el('span', null, status.label));
      const right = el('span', 'col-head-right');
      if (status.key === 'backlog' && issues.length) right.appendChild(sortToggle());
      if (status.key === 'done' && issues.length && !state.query) {
        const sweep = el('button', 'sweep-btn', 'Sweep');
        sweep.title = 'Move all Done issues to the archive';
        sweep.addEventListener('click', async () => {
          if (!confirm(`Sweep ${issues.length} done issue${issues.length === 1 ? '' : 's'} to the archive?`)) return;
          await api(`/api/projects/${encodeURIComponent(state.projectKey)}/sweep`, { method: 'POST' });
          refresh();
        });
        right.appendChild(sweep);
      }
      right.appendChild(el('span', 'col-count', String(issues.length)));
      head.appendChild(right);
      col.appendChild(head);

      const list = el('div', 'col-cards');
      list.dataset.status = status.key;
      list.addEventListener('dragover', onDragOver);
      list.addEventListener('dragleave', onDragLeave);
      list.addEventListener('drop', onDrop);
      if (!issues.length) list.appendChild(el('div', 'empty', '—'));
      for (const issue of issues) list.appendChild(renderCard(issue));
      col.appendChild(list);
      $board.appendChild(col);
    }
    $board.querySelectorAll('.col-cards').forEach((c) => {
      if (scrolls[c.dataset.status] != null) c.scrollTop = scrolls[c.dataset.status];
    });
  }

  function renderCard(issue) {
    const card = el('div', 'card');
    card.draggable = true;
    card.dataset.id = issue.id;
    card.dataset.ordinal = issue.ordinal;

    const top = el('div', 'card-top');
    if (isNew(issue)) top.appendChild(el('span', 'new-dot'));
    top.appendChild(el('span', 'card-id', issue.id));
    top.appendChild(copyRefBtn(issue));
    top.appendChild(activityAge(issue));
    card.appendChild(top);

    card.appendChild(el('div', 'card-title', issue.title || (issue.seeing || '').slice(0, 80) || '(untitled)'));

    const meta = el('div', 'card-meta split');
    const tags = el('div', 'meta-tags');
    tags.appendChild(el('span', `pill pill-type-${issue.type}`, issue.type));
    for (const tag of issue.tags || []) tags.appendChild(el('span', 'tag', tag));
    meta.appendChild(tags);
    meta.appendChild(severityBars(issue.severity)); // fixed spot, far right
    card.appendChild(meta);

    card.addEventListener('click', () => openDrawer(issue.id));
    card.addEventListener('dragstart', (e) => {
      state.draggingId = issue.id;
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', issue.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      state.draggingId = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.drag-over, .drop-before').forEach((n) => n.classList.remove('drag-over', 'drop-before'));
      refresh();
    });
    return card;
  }

  function renderArchive() {
    const visible = state.closed.filter((i) => matchesQuery(i, state.query));
    $count.textContent = `${visible.length} archived issue${visible.length === 1 ? '' : 's'}`;
    $board.className = 'archive';
    $board.replaceChildren();
    $board.appendChild(el('p', 'view-note', "These issues were swept from the Done column. They're kept here as a read-only history of finished work."));
    if (!visible.length) {
      $board.appendChild(el('div', 'hint', state.query ? 'No archived issues match the search.' : 'Nothing swept yet. Use “Sweep” on the Done column to archive finished issues.'));
      return;
    }
    const list = el('div', 'archive-list');
    for (const issue of visible) {
      const row = el('div', 'archive-row');
      row.appendChild(el('span', 'card-id', issue.id));
      row.appendChild(copyRefBtn(issue));
      row.appendChild(el('span', 'archive-title', issue.title || (issue.seeing || '').slice(0, 80) || '(untitled)'));
      const meta = el('span', 'card-meta');
      meta.appendChild(el('span', `pill pill-type-${issue.type}`, issue.type));
      meta.appendChild(severityBars(issue.severity));
      meta.appendChild(el('span', 'card-age', `closed ${issue.closed ? new Date(issue.closed).toLocaleDateString() : ''}`));
      row.appendChild(meta);
      row.addEventListener('click', () => openDrawer(issue.id));
      list.appendChild(row);
    }
    $board.appendChild(list);
  }

  function renderIcebox() {
    const visible = state.icebox.filter((i) => matchesQuery(i, state.query));
    $count.textContent = `${visible.length} iceboxed issue${visible.length === 1 ? '' : 's'}`;
    $board.className = 'archive';
    $board.replaceChildren();
    $board.appendChild(el('p', 'view-note', "Parked backlog items, off the board and out of agents' reach. Bring one back to the Backlog whenever you're ready."));
    if (!visible.length) {
      $board.appendChild(el('div', 'hint', state.query ? 'No iceboxed issues match the search.' : 'The icebox is empty. Open a backlog issue and use “Send to Icebox” to park it for later.'));
      return;
    }
    const list = el('div', 'archive-list');
    for (const issue of visible) {
      const row = el('div', 'archive-row');
      row.appendChild(el('span', 'card-id', issue.id));
      row.appendChild(copyRefBtn(issue));
      row.appendChild(el('span', 'archive-title', issue.title || (issue.seeing || '').slice(0, 80) || '(untitled)'));
      const meta = el('span', 'card-meta');
      meta.appendChild(el('span', `pill pill-type-${issue.type}`, issue.type));
      meta.appendChild(severityBars(issue.severity));
      meta.appendChild(el('span', 'card-age', `iced ${issue.iceboxed ? new Date(issue.iceboxed).toLocaleDateString() : ''}`));
      const back = el('button', 'btn revive-btn', '↑ Backlog');
      back.title = 'Bring this item back to the board (Backlog)';
      back.addEventListener('click', async (e) => {
        e.stopPropagation();
        back.disabled = true;
        try {
          await api(`/api/issues/${encodeURIComponent(issue.id)}/revive`, { method: 'POST' });
          refresh();
        } catch (err) {
          back.disabled = false;
          console.warn('revive failed', err);
        }
      });
      meta.appendChild(back);
      row.appendChild(meta);
      row.addEventListener('click', () => openDrawer(issue.id));
      list.appendChild(row);
    }
    $board.appendChild(list);
  }

  // ---- drag & drop --------------------------------------------------------

  function cardAfterPointer(list, y) {
    const cards = [...list.querySelectorAll('.card:not(.dragging)')];
    return cards.find((c) => y < c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2) || null;
  }

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const list = e.currentTarget;
    list.classList.add('drag-over');
    list.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'));
    const after = cardAfterPointer(list, e.clientY);
    if (after) after.classList.add('drop-before');
  }

  function onDragLeave(e) {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    e.currentTarget.classList.remove('drag-over');
    e.currentTarget.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'));
  }

  async function onDrop(e) {
    e.preventDefault();
    const list = e.currentTarget;
    list.classList.remove('drag-over');
    const id = e.dataTransfer.getData('text/plain');
    const status = list.dataset.status;
    const columnIssues = state.issues
      .filter((i) => i.status === status && i.id !== id)
      .sort((a, b) => a.ordinal - b.ordinal);

    const before = cardAfterPointer(list, e.clientY);
    let ordinal;
    if (!columnIssues.length) {
      ordinal = 1000;
    } else if (!before) {
      ordinal = columnIssues[columnIssues.length - 1].ordinal + 1000;
    } else {
      const idx = columnIssues.findIndex((i) => i.id === before.dataset.id);
      const prev = idx > 0 ? columnIssues[idx - 1].ordinal : 0;
      ordinal = (prev + columnIssues[idx].ordinal) / 2;
    }

    state.draggingId = null;
    try {
      await api(`/api/issues/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ordinal }),
      });
    } catch (err) {
      console.warn('reorder failed', err);
    }
    refresh();
  }

  // ---- drawer -------------------------------------------------------------

  function closeDrawer() {
    state.drawerId = null;
    $drawer.hidden = true;
    $backdrop.hidden = true;
    if (location.hash) history.replaceState(null, '', location.pathname);
  }

  $backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.drawerId) closeDrawer();
  });

  async function openDrawer(id) {
    let issue;
    try {
      issue = await api(`/api/issues/${encodeURIComponent(id)}`);
    } catch {
      return;
    }
    const readOnly = !!issue.closed || !!issue.iceboxed;
    state.drawerId = id;
    history.replaceState(null, '', `#${encodeURIComponent(id)}`);
    $drawer.replaceChildren();
    $drawer.hidden = false;
    $backdrop.hidden = false;

    const head = el('div', 'drawer-head');
    const titleWrap = el('div');
    const idRow = el('div', 'drawer-id-row');
    idRow.appendChild(el('span', 'drawer-id', issue.id));
    idRow.appendChild(copyRefBtn(issue));
    titleWrap.appendChild(idRow);
    titleWrap.appendChild(el('h2', null, issue.title || '(untitled)'));
    head.appendChild(titleWrap);
    const close = el('button', 'drawer-close', '×');
    close.addEventListener('click', closeDrawer);
    head.appendChild(close);
    $drawer.appendChild(head);

    // Click-to-change type/severity. Closed issues reject mutations (assertOpen),
    // so they stay static pills; open issues get a colored dropdown in their place.
    function patchPill(field, current, colorClass, options) {
      const sel = el('select', `pill pill-select ${colorClass}`);
      sel.title = field === 'type' ? 'Type (click to change)' : 'Severity (click to change)';
      sel.setAttribute('aria-label', sel.title);
      for (const o of options) {
        const opt = el('option', null, o.label);
        opt.value = String(o.value);
        if (String(o.value) === String(current)) opt.selected = true;
        sel.appendChild(opt);
      }
      const cls = (v) => (field === 'severity' ? `pill-sev-${v}` : `pill-type-${v}`);
      sel.addEventListener('change', async () => {
        const prev = issue[field]; // last committed value (the select persists across edits)
        const value = field === 'severity' ? Number(sel.value) : sel.value;
        if (value === prev) return;
        try {
          await api(`/api/issues/${encodeURIComponent(issue.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value }),
          });
          // Recolor the pill in place. There's no full re-render, so keyboard
          // focus and the drawer's scroll position are preserved.
          sel.classList.replace(cls(prev), cls(value));
          issue[field] = value;
          refresh(); // sync the board card's color/severity
        } catch (err) {
          console.warn(`update ${field} failed`, err);
          sel.value = String(prev); // revert to the last committed value
          openDrawer(issue.id); // resync, flipping the drawer to read-only if the issue was closed mid-edit
        }
      });
      return sel;
    }

    const meta = el('div', 'drawer-meta');
    if (readOnly) {
      meta.appendChild(el('span', `pill pill-type-${issue.type}`, issue.type));
      meta.appendChild(el('span', `pill pill-sev pill-sev-${issue.severity}`, `Severity ${issue.severity}`));
    } else {
      meta.appendChild(patchPill('type', issue.type, `pill-type-${issue.type}`, TYPES.map((t) => ({ value: t, label: t }))));
      meta.appendChild(patchPill('severity', issue.severity, `pill-sev pill-sev-${issue.severity}`, [1, 2, 3, 4, 5].map((s) => ({ value: s, label: `Severity ${s}` }))));
    }
    for (const tag of issue.tags || []) meta.appendChild(el('span', 'tag', tag));
    if (issue.relatedTo) meta.appendChild(el('span', 'tag', `related: ${issue.relatedTo}`));
    if (issue.closed) meta.appendChild(el('span', 'pill pill-closed', `archived ${new Date(issue.closed).toLocaleDateString()}`));
    else if (issue.iceboxed) meta.appendChild(el('span', 'pill pill-iceboxed', `iceboxed ${new Date(issue.iceboxed).toLocaleDateString()}`));
    $drawer.appendChild(meta);

    // Both timestamps live here; the board card shows only the last-activity age.
    const times = el('div', 'drawer-times');
    const upIso = lastActivityIso(issue);
    const created = el('span', 'dtime');
    created.appendChild(el('span', 'dtime-k', 'Created'));
    created.appendChild(el('span', 'dtime-v', fmtDate(issue.created)));
    times.appendChild(created);
    const updated = el('span', 'dtime');
    updated.appendChild(el('span', 'dtime-k', 'Updated'));
    const uv = el('span', 'dtime-v', `${relAge(upIso)} ago`);
    uv.style.color = heatColor(upIso);
    updated.appendChild(uv);
    times.appendChild(updated);
    $drawer.appendChild(times);

    const actions = el('div', 'drawer-actions');
    if (!readOnly) {
      const statusSelect = el('select');
      statusSelect.id = 'status-select';
      for (const s of STATUSES) {
        const opt = el('option', null, s.label);
        opt.value = s.key;
        statusSelect.appendChild(opt);
      }
      statusSelect.value = issue.status;
      statusSelect.addEventListener('change', async () => {
        try {
          await api(`/api/issues/${encodeURIComponent(issue.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: statusSelect.value }),
          });
        } catch (err) {
          console.warn('update status failed', err); // never leave an unhandled rejection
        }
        refresh();
        openDrawer(issue.id); // re-render so the drawer reflects server state (read-only if closed)
      });
      actions.appendChild(statusSelect);
    }

    const copyBtn = el('button', 'btn btn-primary', 'Copy Prompt');
    copyBtn.addEventListener('click', async () => {
      try {
        const text = await api(`/api/issues/${encodeURIComponent(issue.id)}/prompt`);
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied!';
      } catch {
        copyBtn.textContent = 'Copy failed';
      }
      setTimeout(() => (copyBtn.textContent = 'Copy Prompt'), 1800);
    });
    actions.appendChild(copyBtn);

    if (issue.iceboxed) {
      const reviveBtn = el('button', 'btn btn-primary', '↑ Bring back to board');
      reviveBtn.addEventListener('click', async () => {
        reviveBtn.disabled = true;
        try {
          await api(`/api/issues/${encodeURIComponent(issue.id)}/revive`, { method: 'POST' });
          closeDrawer();
          refresh();
        } catch (err) {
          reviveBtn.disabled = false;
          console.warn('revive failed', err);
        }
      });
      actions.appendChild(reviveBtn);
    } else if (!readOnly && issue.status === 'backlog') {
      const iceboxBtn = el('button', 'btn', 'Send to Icebox');
      iceboxBtn.title = 'Park this backlog item off the board; bring it back any time';
      iceboxBtn.addEventListener('click', async () => {
        iceboxBtn.disabled = true;
        try {
          await api(`/api/issues/${encodeURIComponent(issue.id)}/icebox`, { method: 'POST' });
          closeDrawer();
          refresh();
        } catch (err) {
          iceboxBtn.disabled = false;
          console.warn('icebox failed', err);
        }
      });
      actions.appendChild(iceboxBtn);
    }
    $drawer.appendChild(actions);

    const seeing = el('div', 'section');
    seeing.appendChild(el('h3', null, 'Seeing'));
    seeing.appendChild(el('div', 'prose', issue.seeing || '—'));
    $drawer.appendChild(seeing);

    const expecting = el('div', 'section');
    expecting.appendChild(el('h3', null, 'Expecting'));
    expecting.appendChild(el('div', 'prose', issue.expecting || '—'));
    $drawer.appendChild(expecting);

    if (issue.resolution) {
      const resolution = el('div', 'section section-resolution');
      resolution.appendChild(el('h3', null, 'Resolution'));
      resolution.appendChild(el('div', 'prose', issue.resolution));
      if (issue.modifiedFiles?.length) {
        const files = el('div', 'modified-files');
        for (const f of issue.modifiedFiles) files.appendChild(el('span', 'tag', f));
        resolution.appendChild(files);
      }
      $drawer.appendChild(resolution);
    }

    if (issue.context) {
      const ctx = el('div', 'section');
      ctx.appendChild(el('h3', null, 'Context'));
      const list = el('ul', 'ctx-list');
      const c = issue.context;
      if (c.url) list.appendChild(el('li', null, `URL: ${c.url}`));
      if (c.viewport?.w) list.appendChild(el('li', null, `Viewport: ${c.viewport.w}×${c.viewport.h}`));
      if (c.capturedAt) list.appendChild(el('li', null, `Captured: ${c.capturedAt}`));
      if (c.selectedText) list.appendChild(el('li', null, `Selected text: "${c.selectedText}"`));
      if (c.pointedElement?.selector) list.appendChild(el('li', null, `Pointed element: ${c.pointedElement.selector}`));
      if (c.recentErrors?.length) list.appendChild(el('li', null, `JS errors: ${c.recentErrors.length} (latest: ${c.recentErrors.at(-1).message})`));
      if (c.recentFetchFailures?.length) list.appendChild(el('li', null, `Failed requests: ${c.recentFetchFailures.length}`));
      if (c.clickBreadcrumbs?.length) list.appendChild(el('li', null, `Click breadcrumbs: ${c.clickBreadcrumbs.length}`));
      const git = c.git || c.app?.git;
      if (git?.branch) list.appendChild(el('li', null, `Branch at capture: ${git.branch}${git.commit ? ` @ ${git.commit}` : ''}`));
      ctx.appendChild(list);

      const details = el('details', 'ctx-json');
      details.appendChild(el('summary', null, 'Full context JSON'));
      details.appendChild(el('pre', null, JSON.stringify(issue.context, null, 2)));
      ctx.appendChild(details);
      $drawer.appendChild(ctx);
    }

    const comments = el('div', 'section');
    comments.appendChild(el('h3', null, `Comments (${issue.comments.length})`));
    for (const c of issue.comments) {
      const item = el('div', 'comment');
      item.appendChild(el('div', 'comment-head', `${c.author}, ${c.at ? new Date(c.at).toLocaleString() : ''}`));
      item.appendChild(el('div', 'comment-body', c.text));
      comments.appendChild(item);
    }

    if (!readOnly) {
      const form = el('div', 'comment-form');
      const ta = el('textarea');
      ta.placeholder = 'Add a comment…';
      const row = el('div', 'row');
      const author = el('input');
      author.value = localStorage.getItem('it-author') || 'igor';
      const send = el('button', 'btn', 'Comment');
      send.addEventListener('click', async () => {
        if (!ta.value.trim()) return;
        localStorage.setItem('it-author', author.value || 'igor');
        await api(`/api/issues/${encodeURIComponent(issue.id)}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ author: author.value || 'igor', text: ta.value }),
        });
        openDrawer(issue.id);
      });
      row.appendChild(author);
      row.appendChild(send);
      form.appendChild(ta);
      form.appendChild(row);
      comments.appendChild(form);
    }
    $drawer.appendChild(comments);

    // ---- danger zone: permanent delete (two-step confirm) -----------------
    const danger = el('div', 'section danger-zone');
    danger.appendChild(el('h3', null, 'Danger zone'));

    const delBtn = el('button', 'btn btn-danger del-issue', 'Delete issue');
    danger.appendChild(delBtn);

    const confirm = el('div', 'danger-confirm');
    confirm.style.display = 'none';
    confirm.appendChild(el('div', 'danger-warn', `Permanently delete ${issue.id}? This can’t be undone. The issue file is removed for good.`));
    const confirmBtns = el('div', 'danger-btns');
    const cancelDel = el('button', 'btn', 'Cancel');
    const reallyDel = el('button', 'btn btn-danger del-confirm', 'Delete permanently');
    confirmBtns.appendChild(cancelDel);
    confirmBtns.appendChild(reallyDel);
    confirm.appendChild(confirmBtns);
    const delErr = el('div', 'form-error', '');
    delErr.setAttribute('role', 'alert'); // announce failures to assistive tech
    confirm.appendChild(delErr);
    danger.appendChild(confirm);

    delBtn.addEventListener('click', () => {
      delBtn.style.display = 'none';
      confirm.style.display = 'flex';
      cancelDel.focus(); // land on the safe action, not the destructive one
    });
    cancelDel.addEventListener('click', () => {
      confirm.style.display = 'none';
      delBtn.style.display = 'inline-block';
      delErr.textContent = '';
    });
    reallyDel.addEventListener('click', async () => {
      reallyDel.disabled = true;
      cancelDel.disabled = true;
      try {
        await api(`/api/issues/${encodeURIComponent(issue.id)}`, { method: 'DELETE' });
        closeDrawer();
        refresh();
      } catch (err) {
        reallyDel.disabled = false;
        cancelDel.disabled = false;
        delErr.textContent = `Could not delete: ${err.message}`;
      }
    });
    $drawer.appendChild(danger);
  }

  // ---- tag field ------------------------------------------------------------
  // Chips + typeahead over the project's existing tags (GET /api/projects/:key/tags).
  // Focusing the field lists the most-used tags with counts; typing filters them;
  // an unknown name gets an explicit "new tag" row so growing the vocabulary is
  // always deliberate. The pencil on a suggestion opens inline rename / delete,
  // and renaming onto an existing name becomes a merge. Picking a tag commits
  // the chip and closes the dropdown; click the field again to add another.

  function pencilGlyph() {
    return svgIcon([svgPath('M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z')]);
  }

  function tagField(projectKey) {
    const tagsUrl = `/api/projects/${encodeURIComponent(projectKey)}/tags`;
    let vocab = []; // [{name, count, lastUsed}] from the server
    let selected = [];
    let open = false;
    let activeIndex = -1;
    let editing = null; // tag name being edited inline, or null

    const root = el('div', 'tagfield');
    const box = el('div', 'tagbox');
    const input = el('input');
    input.placeholder = 'Type to search or create…';
    input.autocomplete = 'off';
    box.appendChild(input);
    const dd = el('div', 'tag-dd');
    const list = el('div', 'tag-dd-list');
    const hints = el('div', 'tag-dd-hint');
    for (const [keys, label] of [[['↑', '↓'], 'navigate'], [['↵'], 'add'], [['esc'], 'close']]) {
      const span = el('span');
      for (const k of keys) span.appendChild(el('kbd', null, k));
      span.appendChild(document.createTextNode(` ${label}`));
      hints.appendChild(span);
    }
    dd.appendChild(list);
    dd.appendChild(hints);
    const recent = el('div', 'tag-recent');
    root.appendChild(box);
    root.appendChild(dd);
    root.appendChild(recent);

    const query = () => input.value.trim().toLowerCase();
    const knownName = (name) => {
      const hit = vocab.find((t) => t.name.toLowerCase() === name.toLowerCase());
      return hit ? hit.name : null;
    };

    function matches() {
      const q = query();
      return vocab
        .filter((t) => !selected.includes(t.name) && (!q || t.name.toLowerCase().includes(q)))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }

    function addTag(name) {
      name = name.trim().replace(/,/g, '');
      if (!name) return;
      name = knownName(name) || name;
      if (!selected.includes(name)) selected.push(name);
      input.value = '';
      activeIndex = -1;
      open = false;
      editing = null;
      renderAll();
      input.blur();
    }

    function removeTag(name) {
      selected = selected.filter((n) => n !== name);
      renderAll();
    }

    function renderChips() {
      box.querySelectorAll('.tagchip').forEach((c) => c.remove());
      for (const name of selected) {
        const chip = el('span', 'tagchip', name);
        const x = el('button', 'tagchip-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', `Remove tag ${name}`);
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          removeTag(name);
        });
        chip.appendChild(x);
        box.insertBefore(chip, input);
      }
    }

    function renderRecent() {
      recent.replaceChildren();
      const latest = vocab
        .filter((t) => !selected.includes(t.name))
        .sort((a, b) => String(b.lastUsed).localeCompare(String(a.lastUsed)))
        .slice(0, 6);
      if (!latest.length) return;
      recent.appendChild(el('span', 'tag-recent-label', 'Recent:'));
      for (const t of latest) {
        const b = el('button', 'tag-recent-chip');
        b.type = 'button';
        b.appendChild(el('span', null, '+'));
        b.appendChild(document.createTextNode(t.name));
        b.addEventListener('click', () => addTag(t.name));
        recent.appendChild(b);
      }
    }

    function highlightName(name) {
      const holder = el('span', 'tag-dd-name');
      const q = query();
      const i = q ? name.toLowerCase().indexOf(q) : -1;
      if (i < 0) {
        holder.textContent = name;
        return holder;
      }
      holder.appendChild(document.createTextNode(name.slice(0, i)));
      holder.appendChild(el('b', null, name.slice(i, i + q.length)));
      holder.appendChild(document.createTextNode(name.slice(i + q.length)));
      return holder;
    }

    function issueNoun(n) {
      return `${n} ${n === 1 ? 'issue' : 'issues'}`;
    }

    // Inline editor for one vocabulary tag: rename, merge (rename onto an
    // existing name), or delete. Server ops rewrite every issue file carrying
    // the tag, so the board refreshes afterwards.
    function renderEditor(t) {
      const wrap = el('div', 'tag-dd-editor');
      const inp = el('input');
      inp.value = t.name;
      inp.setAttribute('aria-label', `Rename tag ${t.name}`);
      const hint = el('p', 'tag-ed-hint');
      const actions = el('div', 'tag-ed-actions');
      const save = el('button', 'tag-ed-btn primary', 'Rename');
      const cancel = el('button', 'tag-ed-btn', 'Cancel');
      const del = el('button', 'tag-ed-btn danger', 'Delete');
      for (const b of [save, cancel, del]) b.type = 'button';
      actions.appendChild(save);
      actions.appendChild(cancel);
      actions.appendChild(del);
      wrap.appendChild(inp);
      wrap.appendChild(hint);
      wrap.appendChild(actions);

      function mergeTarget() {
        const v = inp.value.trim();
        if (!v || v.toLowerCase() === t.name.toLowerCase()) return null;
        return knownName(v);
      }
      function sync() {
        const target = mergeTarget();
        if (target) {
          save.textContent = `Merge into “${target}”`;
          save.className = 'tag-ed-btn merge';
          hint.className = 'tag-ed-hint merge';
          hint.textContent = `“${target}” already exists. Merging retags ${issueNoun(t.count)}.`;
        } else {
          save.textContent = 'Rename';
          save.className = 'tag-ed-btn primary';
          hint.className = 'tag-ed-hint';
          hint.textContent = `Renames the tag on ${issueNoun(t.count)}.`;
        }
      }
      sync();
      inp.addEventListener('input', sync);
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') save.click();
        if (e.key === 'Escape') cancel.click();
      });

      async function run(op) {
        save.disabled = cancel.disabled = del.disabled = true;
        try {
          await op();
          vocab = await api(tagsUrl);
          editing = null;
          renderAll();
          input.focus();
          refresh(); // tag pills on board cards changed
        } catch (err) {
          save.disabled = cancel.disabled = del.disabled = false;
          hint.className = 'tag-ed-hint error';
          hint.textContent = err.message;
        }
      }
      save.addEventListener('click', () => {
        const to = inp.value.trim();
        if (!to || to === t.name) return;
        run(async () => {
          const res = await api(tagsUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: t.name, to }),
          });
          selected = [...new Set(selected.map((n) => (n === t.name ? res.to : n)))];
        });
      });
      del.addEventListener('click', () => {
        run(async () => {
          await api(`${tagsUrl}/${encodeURIComponent(t.name)}`, { method: 'DELETE' });
          selected = selected.filter((n) => n !== t.name);
        });
      });
      cancel.addEventListener('click', () => {
        editing = null;
        renderDropdown();
        input.focus();
      });

      setTimeout(() => {
        inp.focus();
        inp.select();
      }, 0);
      return wrap;
    }

    function renderDropdown() {
      list.replaceChildren();
      const rows = matches();
      const q = query();
      const creatable = q && !knownName(q) && !selected.some((n) => n.toLowerCase() === q);
      activeIndex = Math.min(activeIndex, rows.length - (creatable ? 0 : 1));

      rows.forEach((t, i) => {
        if (editing === t.name) {
          list.appendChild(renderEditor(t));
          return;
        }
        const row = el('div', 'tag-dd-row' + (i === activeIndex ? ' active' : ''));
        row.appendChild(highlightName(t.name));
        row.appendChild(el('span', 'tag-dd-count', String(t.count)));
        const edit = el('button', 'tag-dd-edit');
        edit.type = 'button';
        edit.setAttribute('aria-label', `Edit tag ${t.name}`);
        edit.appendChild(pencilGlyph());
        edit.addEventListener('click', (e) => {
          e.stopPropagation();
          editing = t.name;
          renderDropdown();
        });
        row.appendChild(edit);
        row.addEventListener('click', () => addTag(t.name));
        row.addEventListener('mousemove', () => {
          if (activeIndex !== i) {
            activeIndex = i;
            paintActive();
          }
        });
        list.appendChild(row);
      });

      if (creatable) {
        const row = el('div', 'tag-dd-row tag-dd-create' + (activeIndex === rows.length ? ' active' : ''));
        row.appendChild(el('span', 'tag-dd-plus', '+'));
        const label = el('span', 'tag-dd-name');
        label.appendChild(document.createTextNode('Create “'));
        label.appendChild(el('b', null, input.value.trim()));
        label.appendChild(document.createTextNode('”'));
        row.appendChild(label);
        row.appendChild(el('span', 'tag-dd-new', 'new tag'));
        row.addEventListener('click', () => addTag(input.value));
        row.addEventListener('mousemove', () => {
          activeIndex = rows.length;
          paintActive();
        });
        list.appendChild(row);
      }

      if (!list.children.length) {
        const empty = el('div', 'tag-dd-editor');
        empty.appendChild(el('p', 'tag-ed-hint', vocab.length ? 'All tags are already on this issue.' : 'No tags in this project yet. Type to create the first one.'));
        list.appendChild(empty);
      }

      dd.classList.toggle('open', open);
      if (open) dd.scrollIntoView({ block: 'nearest' });
    }

    function paintActive() {
      [...list.querySelectorAll('.tag-dd-row')].forEach((r, i) => r.classList.toggle('active', i === activeIndex));
    }

    function renderAll() {
      renderChips();
      renderRecent();
      renderDropdown();
    }

    box.addEventListener('click', () => input.focus());
    input.addEventListener('focus', () => {
      open = true;
      renderDropdown();
    });
    input.addEventListener('input', () => {
      open = true;
      activeIndex = query() ? 0 : -1;
      renderDropdown();
    });
    input.addEventListener('keydown', (e) => {
      const rowCount = list.querySelectorAll('.tag-dd-row').length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        open = true;
        activeIndex = Math.min(activeIndex + 1, rowCount - 1);
        renderDropdown();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        renderDropdown();
      } else if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const rowEls = list.querySelectorAll('.tag-dd-row');
        if (activeIndex >= 0 && rowEls[activeIndex]) rowEls[activeIndex].click();
        else if (query()) addTag(input.value);
      } else if (e.key === 'Escape') {
        if (open) e.stopPropagation(); // eat it so the modal stays open
        open = false;
        editing = null;
        renderDropdown();
      } else if (e.key === 'Backspace' && !input.value && selected.length) {
        removeTag(selected[selected.length - 1]);
      }
    });

    // Click-outside closes the dropdown. Self-detaches once the modal is gone.
    function onDocMousedown(e) {
      if (!root.isConnected) {
        document.removeEventListener('mousedown', onDocMousedown);
        return;
      }
      if (!root.contains(e.target) && (open || editing)) {
        open = false;
        editing = null;
        renderDropdown();
      }
    }
    document.addEventListener('mousedown', onDocMousedown);

    api(tagsUrl)
      .then((t) => {
        vocab = t;
        renderRecent();
        if (open) renderDropdown();
      })
      .catch(() => {}); // no vocabulary is fine; the field still takes new tags

    return {
      root,
      // Selected chips plus whatever is still typed in the field, so an
      // uncommitted tag isn't lost when the user goes straight to submit.
      getTags() {
        const leftovers = input.value.split(',').map((s) => s.trim()).filter(Boolean);
        return [...new Set([...selected, ...leftovers.map((n) => knownName(n) || n)])];
      },
    };
  }

  // ---- new issue modal ----------------------------------------------------

  document.getElementById('new-issue').addEventListener('click', () => {
    if (!state.projectKey) {
      alert('Register a project first (capture from a widget once, or POST /api/projects).');
      return;
    }
    openNewIssueModal();
  });

  function openNewIssueModal() {
    if (document.querySelector('.modal-backdrop')) return;
    let selectedType = 'improvement';
    let selectedSev = 3;

    const backdrop = el('div', 'modal-backdrop');
    const modal = el('div', 'modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'New issue');

    const head = el('div', 'modal-head');
    head.appendChild(el('b', null, `New issue in ${state.projectKey}`));
    const x = el('button', 'drawer-close', '×');
    head.appendChild(x);
    modal.appendChild(head);

    const body = el('div', 'modal-body');

    const typeRow = el('div', 'form-row');
    typeRow.appendChild(el('span', 'form-label', 'Type'));
    const pills = el('div', 'form-pills');
    for (const t of TYPES) {
      const pill = el('button', `form-pill${t === selectedType ? ' on' : ''}`, t);
      pill.addEventListener('click', () => {
        selectedType = t;
        pills.querySelectorAll('.form-pill').forEach((p) => p.classList.toggle('on', p.textContent === t));
      });
      pills.appendChild(pill);
    }
    typeRow.appendChild(pills);
    body.appendChild(typeRow);

    const titleRow = el('div', 'form-row');
    titleRow.appendChild(el('span', 'form-label', 'Title (optional)'));
    const title = el('input', 'form-input');
    title.placeholder = 'Short summary';
    titleRow.appendChild(title);
    body.appendChild(titleRow);

    const seeingRow = el('div', 'form-row');
    seeingRow.appendChild(el('span', 'form-label', 'What is wrong / current state *'));
    const seeing = el('textarea', 'form-input');
    seeing.rows = 4;
    seeingRow.appendChild(seeing);
    body.appendChild(seeingRow);

    const expRow = el('div', 'form-row');
    expRow.appendChild(el('span', 'form-label', 'What should happen / requirements *'));
    const expecting = el('textarea', 'form-input');
    expecting.rows = 3;
    expRow.appendChild(expecting);
    body.appendChild(expRow);

    const sevRow = el('div', 'form-row');
    sevRow.appendChild(el('span', 'form-label', 'Severity'));
    const sevs = el('div', 'form-pills');
    for (let s = 1; s <= 5; s++) {
      const dot = el('button', `sev-dot${s <= selectedSev ? ' on' : ''}`, String(s));
      dot.addEventListener('click', () => {
        selectedSev = s;
        [...sevs.children].forEach((d, i) => d.classList.toggle('on', i < s));
      });
      sevs.appendChild(dot);
    }
    sevRow.appendChild(sevs);
    body.appendChild(sevRow);

    const tagsRow = el('div', 'form-row');
    tagsRow.appendChild(el('span', 'form-label', 'Tags'));
    const tags = tagField(state.projectKey);
    tagsRow.appendChild(tags.root);
    body.appendChild(tagsRow);

    const error = el('div', 'form-error', '');
    body.appendChild(error);
    modal.appendChild(body);

    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'btn', 'Cancel');
    const submit = el('button', 'btn btn-primary', 'Create issue');
    actions.appendChild(cancel);
    actions.appendChild(submit);
    modal.appendChild(actions);

    function close() {
      backdrop.remove();
      modal.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    x.addEventListener('click', close);
    cancel.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    submit.addEventListener('click', async () => {
      if (!seeing.value.trim() || !expecting.value.trim()) {
        error.textContent = 'Both required fields must be filled in.';
        return;
      }
      submit.disabled = true;
      try {
        const issue = await api('/api/issues', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: state.projectKey,
            title: title.value.trim(),
            type: selectedType,
            severity: selectedSev,
            tags: tags.getTags(),
            seeing: seeing.value,
            expecting: expecting.value,
            context: { source: 'tracker-ui', capturedAt: new Date().toISOString() },
          }),
        });
        close();
        setView('board');
        await refresh();
        openDrawer(issue.id);
      } catch (err) {
        submit.disabled = false;
        error.textContent = `Could not create issue: ${err.message}`;
      }
    });

    $modalRoot.appendChild(backdrop);
    $modalRoot.appendChild(modal);
    seeing.focus();
  }

  // ---- boot ---------------------------------------------------------------

  async function boot() {
    // New-since-last-seen: compare each card's created time against the last
    // visit. The first visit ever stamps "now" so nothing floods in as new.
    const storedSeen = localStorage.getItem('it-last-seen');
    state.lastSeenAt = storedSeen ? Number(storedSeen) : Date.now();
    if (!storedSeen) localStorage.setItem('it-last-seen', String(state.lastSeenAt));
    const markSeen = () => localStorage.setItem('it-last-seen', String(Date.now()));
    addEventListener('beforeunload', markSeen);
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') markSeen(); });

    await loadProjects();

    // deep link: #<issue-id> selects the project and opens the drawer
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash) {
      const m = /^(.+)-\d+$/.exec(hash);
      if (m && state.projects.some((p) => p.key === m[1])) {
        state.projectKey = m[1];
        $select.value = m[1];
      }
    }
    await refresh();
    if (hash) openDrawer(hash);

    setInterval(async () => {
      try {
        await loadProjects();
        if (state.projectKey) $select.value = state.projectKey;
        await refresh();
      } catch (err) {
        console.warn('poll failed', err);
      }
    }, POLL_MS);
  }

  boot();
})();
