/* Tracker board UI. All user-generated strings are rendered via textContent, never innerHTML. */
(function () {
  'use strict';

  const STATUSES = [
    { key: 'backlog', label: 'Backlog' },
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
    view: 'board', // board | archive
    query: '',
    draggingId: null,
    drawerId: null,
  };

  const $board = document.getElementById('board');
  const $select = document.getElementById('project-select');
  const $count = document.getElementById('issue-count');
  const $search = document.getElementById('search');
  const $drawer = document.getElementById('drawer');
  const $backdrop = document.getElementById('drawer-backdrop');
  const $modalRoot = document.getElementById('modal-root');
  const $viewBoard = document.getElementById('view-board');
  const $viewArchive = document.getElementById('view-archive');

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
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
  $viewArchive.addEventListener('click', () => setView('archive'));

  function setView(view) {
    state.view = view;
    $viewBoard.classList.toggle('on', view === 'board');
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
    $count.textContent = state.query
      ? `${visible.length} of ${state.issues.length} issue${state.issues.length === 1 ? '' : 's'}`
      : `${state.issues.length} issue${state.issues.length === 1 ? '' : 's'}`;
    $board.className = '';
    $board.replaceChildren();
    for (const status of STATUSES) {
      const issues = visible.filter((i) => i.status === status.key);
      const col = el('div', 'col');
      const head = el('div', 'col-head');
      head.appendChild(el('span', null, status.label));
      const right = el('span', 'col-head-right');
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
  }

  function renderCard(issue) {
    const card = el('div', 'card');
    card.draggable = true;
    card.dataset.id = issue.id;
    card.dataset.ordinal = issue.ordinal;

    const top = el('div', 'card-top');
    top.appendChild(el('span', 'card-id', issue.id));
    top.appendChild(el('span', 'card-age', relAge(issue.created)));
    card.appendChild(top);

    card.appendChild(el('div', 'card-title', issue.title || (issue.seeing || '').slice(0, 80) || '(untitled)'));

    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', `pill pill-type-${issue.type}`, issue.type));
    meta.appendChild(el('span', `pill pill-sev pill-sev-${issue.severity}`, `S${issue.severity}`));
    for (const tag of issue.tags || []) meta.appendChild(el('span', 'tag', tag));
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
    if (!visible.length) {
      $board.appendChild(el('div', 'hint', state.query ? 'No archived issues match the search.' : 'Nothing swept yet. Use “Sweep” on the Done column to archive finished issues.'));
      return;
    }
    const list = el('div', 'archive-list');
    for (const issue of visible) {
      const row = el('div', 'archive-row');
      row.appendChild(el('span', 'card-id', issue.id));
      row.appendChild(el('span', 'archive-title', issue.title || (issue.seeing || '').slice(0, 80) || '(untitled)'));
      const meta = el('span', 'card-meta');
      meta.appendChild(el('span', `pill pill-type-${issue.type}`, issue.type));
      meta.appendChild(el('span', `pill pill-sev pill-sev-${issue.severity}`, `S${issue.severity}`));
      meta.appendChild(el('span', 'card-age', `closed ${issue.closed ? new Date(issue.closed).toLocaleDateString() : ''}`));
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
    const readOnly = !!issue.closed;
    state.drawerId = id;
    history.replaceState(null, '', `#${encodeURIComponent(id)}`);
    $drawer.replaceChildren();
    $drawer.hidden = false;
    $backdrop.hidden = false;

    const head = el('div', 'drawer-head');
    const titleWrap = el('div');
    titleWrap.appendChild(el('div', 'drawer-id', issue.id));
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
    meta.appendChild(el('span', 'card-age', `created ${relAge(issue.created)} ago`));
    if (issue.relatedTo) meta.appendChild(el('span', 'tag', `related: ${issue.relatedTo}`));
    if (readOnly) meta.appendChild(el('span', 'pill pill-closed', `archived ${new Date(issue.closed).toLocaleDateString()}`));
    $drawer.appendChild(meta);

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
    tagsRow.appendChild(el('span', 'form-label', 'Tags (comma-separated)'));
    const tags = el('input', 'form-input');
    tags.placeholder = 'roadmap, ux';
    tagsRow.appendChild(tags);
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
            tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
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
