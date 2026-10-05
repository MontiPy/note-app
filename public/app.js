import { resolveLink } from '/shared/markdown.js';
import { renderMarkdown, toggleTaskInSource, headingsOf, slugify, splitFrontmatter } from './render.js';
import { setupEditor, insertText, fuzzyScore } from './editor.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};
const baseName = (p) => p.split('/').pop().replace(/\.md$/i, '');
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);

const state = {
  notes: [], // note paths
  folders: [],
  files: [], // attachments
  templatesFolder: 'Templates',
  config: {},
  current: null, // { path, content, mtime }
  dirty: false,
  saving: null,
  conflict: false,
  mode: localStorage.getItem('mode') || 'split',
  openFolders: new Set(JSON.parse(localStorage.getItem('openFolders') || '[]')),
};

// ---------------------------------------------------------------- api

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Notes-App': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
const q = (params) => '?' + new URLSearchParams(params).toString();

function toast(message, ms = 2600) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
const fail = (e) => { console.error(e); toast(e.message || String(e), 4000); };

// ---------------------------------------------------------------- dialogs

// Generic form dialog. Resolves to { name: value } or null when cancelled.
function formDialog({ title, message, fields = [], okLabel = 'OK', danger = false }) {
  const dlg = $('#form-dialog');
  $('#form-dialog-title').textContent = title;
  const container = $('#form-dialog-fields');
  container.replaceChildren();
  if (message) container.append(el('p', { textContent: message }));
  const inputs = {};
  for (const f of fields) {
    let input;
    if (f.type === 'select') {
      input = el('select', { name: f.name }, ...f.options.map((o) => el('option', { value: o.value, textContent: o.label, selected: o.value === f.value })));
    } else {
      input = el('input', { type: 'text', name: f.name, value: f.value ?? '', placeholder: f.placeholder ?? '', required: !!f.required, autocomplete: 'off', spellcheck: false });
    }
    inputs[f.name] = input;
    container.append(el('label', {}, f.label, input, f.help ? el('div', { className: 'help', textContent: f.help }) : null));
  }
  const ok = $('#form-dialog-ok');
  ok.textContent = okLabel;
  ok.className = danger ? 'danger' : 'primary';
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.showModal();
    const first = Object.values(inputs)[0];
    if (first) { first.focus(); first.select?.(); } else ok.focus();
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])));
    }, { once: true });
  });
}
const confirmDialog = (title, message, okLabel = 'Delete') => formDialog({ title, message, okLabel, danger: true }).then((r) => r !== null);

// Searchable list (quick switcher, template picker). `source(query)` returns items
// of { label, detail, run }.
function palette({ placeholder, hint, source }) {
  const dlg = $('#palette');
  const input = $('#palette-input');
  const list = $('#palette-list');
  let items = [];
  let selected = 0;
  input.value = '';
  input.placeholder = placeholder;
  $('#palette-hint').textContent = hint || '↑↓ to navigate · Enter to open · Esc to close';

  const draw = () => {
    items = source(input.value);
    selected = Math.min(selected, Math.max(items.length - 1, 0));
    list.replaceChildren(...items.map((it, i) => {
      const li = el('li', { className: i === selected ? 'sel' : '', role: 'option' }, el('span', { textContent: it.label }), el('small', { textContent: it.detail || '' }));
      li.addEventListener('mousemove', () => { if (selected !== i) { selected = i; mark(); } });
      li.addEventListener('click', () => choose(i));
      return li;
    }));
  };
  const mark = () => [...list.children].forEach((c, i) => c.classList.toggle('sel', i === selected));
  const choose = (i) => { const it = items[i]; dlg.close(); if (it) Promise.resolve(it.run()).catch(fail); };

  input.oninput = () => { selected = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      mark();
      list.children[selected]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(selected);
    }
  };
  draw();
  dlg.showModal();
  input.focus();
}
$('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') e.target.close(); });

// ---------------------------------------------------------------- tree

function isTemplate(path) {
  return state.templatesFolder && path.startsWith(state.templatesFolder + '/');
}

function renderTree() {
  const root = { folders: new Map(), notes: [] };
  const ensure = (path) => {
    let node = root;
    if (!path) return node;
    for (const part of path.split('/')) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), notes: [] });
      node = node.folders.get(part);
    }
    return node;
  };
  state.folders.forEach(ensure);
  state.notes.forEach((p) => ensure(dirName(p)).notes.push(p));

  const build = (node, prefix, depth) => {
    const frag = document.createDocumentFragment();
    for (const name of [...node.folders.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
      const path = joinPath(prefix, name);
      const open = state.openFolders.has(path);
      const row = el('div', { className: 'tree-item folder' + (open ? ' open' : ''), role: 'treeitem', draggable: true, title: path },
        el('span', { className: 'chev', textContent: '▶' }), el('span', { className: 'name', textContent: name }));
      row.dataset.path = path;
      row.dataset.kind = 'folder';
      const children = el('div', { className: 'tree-children', hidden: !open });
      children.append(build(node.folders.get(name), path, depth + 1));
      row.addEventListener('click', () => {
        const nowOpen = !state.openFolders.has(path);
        nowOpen ? state.openFolders.add(path) : state.openFolders.delete(path);
        localStorage.setItem('openFolders', JSON.stringify([...state.openFolders]));
        row.classList.toggle('open', nowOpen);
        children.hidden = !nowOpen;
      });
      frag.append(row, children);
    }
    for (const path of node.notes.sort((a, b) => baseName(a).localeCompare(baseName(b), undefined, { sensitivity: 'base', numeric: true }))) {
      const row = el('div', {
        className: 'tree-item note' + (state.current?.path === path ? ' active' : '') + (isTemplate(path) ? ' template' : ''),
        role: 'treeitem', draggable: true, title: path,
      }, el('span', { className: 'chev' }), el('span', { className: 'name', textContent: baseName(path) }));
      row.dataset.path = path;
      row.dataset.kind = 'note';
      row.addEventListener('click', () => navigate(path));
      frag.append(row);
    }
    return frag;
  };
  const tree = $('#tree');
  tree.replaceChildren(build(root, '', 0));
  if (!state.notes.length && !state.folders.length) tree.append(el('div', { className: 'muted', textContent: 'No notes yet.' }));
}

async function loadTree() {
  const t = await api('GET', '/api/tree');
  state.notes = t.notes.map((n) => n.path);
  state.folders = t.folders;
  state.files = t.files;
  state.templatesFolder = t.templatesFolder;
  renderTree();
}

// Drag notes/folders onto folders (or the empty tree area) to move them.
function setupDragAndDrop() {
  const tree = $('#tree');
  let dragged = null;
  tree.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.tree-item');
    if (!row) return;
    dragged = row.dataset.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged);
  });
  const targetOf = (e) => {
    const row = e.target.closest('.tree-item');
    if (!row) return { dir: '', row: null };
    return row.dataset.kind === 'folder' ? { dir: row.dataset.path, row } : { dir: dirName(row.dataset.path), row: null };
  };
  tree.addEventListener('dragover', (e) => {
    if (!dragged) return;
    e.preventDefault();
    tree.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
    targetOf(e).row?.classList.add('drop-target');
  });
  tree.addEventListener('dragleave', (e) => { e.target.closest?.('.tree-item')?.classList.remove('drop-target'); });
  tree.addEventListener('drop', async (e) => {
    e.preventDefault();
    tree.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
    if (!dragged) return;
    const from = dragged;
    dragged = null;
    const { dir } = targetOf(e);
    const name = from.split('/').pop();
    const to = joinPath(dir, name);
    if (to === from || dir === from || dir.startsWith(from + '/')) return;
    await moveItem(from, to);
  });
  tree.addEventListener('dragend', () => { dragged = null; });
}

// ---------------------------------------------------------------- context menu

function showContextMenu(x, y, entries) {
  const menu = $('#context-menu');
  menu.replaceChildren(...entries.map((it) => {
    if (it === '-') return el('hr');
    const b = el('button', { textContent: it.label, className: it.danger ? 'danger' : '' });
    b.addEventListener('click', () => { hideContextMenu(); Promise.resolve(it.run()).catch(fail); });
    return b;
  }));
  menu.hidden = false;
  const { innerWidth: w, innerHeight: h } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, w - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, h - rect.height - 8) + 'px';
}
const hideContextMenu = () => { $('#context-menu').hidden = true; };
document.addEventListener('click', (e) => { if (!e.target.closest('#context-menu')) hideContextMenu(); });
document.addEventListener('scroll', hideContextMenu, true);

$('#tree').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const row = e.target.closest('.tree-item');
  const path = row?.dataset.path ?? '';
  const isFolder = !row || row.dataset.kind === 'folder';
  const folder = isFolder ? path : dirName(path);
  const entries = [
    { label: 'New note here', run: () => newNote(folder) },
    { label: 'New from template here…', run: () => newFromTemplate(folder) },
    { label: 'New folder here…', run: () => newFolder(folder) },
  ];
  if (row) {
    entries.push('-', { label: 'Rename…', run: () => renameItem(path, isFolder) });
    if (!isFolder) entries.push({ label: 'Duplicate', run: () => duplicateNote(path) });
    entries.push({ label: 'Delete…', danger: true, run: () => deleteItem(path, isFolder) });
  }
  showContextMenu(e.clientX, e.clientY, entries);
});

// ---------------------------------------------------------------- opening & saving

const editor = $('#editor');
const preview = $('#preview');

function navigate(path, opts = {}) {
  state.pendingCursor = opts.cursor;
  state.pendingHeading = opts.heading;
  const hash = '#/' + encodeURIComponent(path);
  if (location.hash === hash) openNote(path).catch(fail);
  else location.hash = hash;
  if (window.innerWidth <= 900) $('#app').classList.remove('show-left');
}

async function openNote(path) {
  if (state.current?.path !== path) await flushSave();
  let note;
  try {
    note = await api('GET', '/api/note' + q({ path }));
  } catch (e) {
    if (e.status === 404) {
      toast(`"${baseName(path)}" no longer exists`);
      await loadTree();
      return showEmpty();
    }
    throw e;
  }
  state.current = note;
  state.dirty = false;
  setConflict(false);
  $('#empty').hidden = true;
  $('#workspace').classList.remove('hidden');
  editor.disabled = false;
  editor.value = note.content;
  $('#note-title').disabled = false;
  $('#note-title').value = baseName(path);
  $('#note-folder').textContent = dirName(path) ? dirName(path) + ' /' : '';
  document.title = `${baseName(path)} — Notes`;
  setStatus('');
  renderPreview();
  renderOutline();
  loadBacklinks();
  document.querySelectorAll('.tree-item.note').forEach((r) => r.classList.toggle('active', r.dataset.path === path));
  revealInTree(path);
  localStorage.setItem('lastNote', path);

  const cursor = state.pendingCursor;
  const heading = state.pendingHeading;
  state.pendingCursor = state.pendingHeading = undefined;
  if (heading) {
    jumpToHeading(heading);
  } else if (typeof cursor === 'number' && cursor >= 0 && state.mode !== 'preview') {
    editor.focus();
    editor.setSelectionRange(cursor, cursor);
  } else {
    editor.scrollTop = 0;
    preview.scrollTop = 0;
  }
}

function revealInTree(path) {
  let changed = false;
  let dir = dirName(path);
  while (dir) {
    if (!state.openFolders.has(dir)) { state.openFolders.add(dir); changed = true; }
    dir = dirName(dir);
  }
  if (changed) {
    localStorage.setItem('openFolders', JSON.stringify([...state.openFolders]));
    renderTree();
  }
}

function showEmpty() {
  state.current = null;
  state.dirty = false;
  editor.value = '';
  editor.disabled = true;
  $('#note-title').value = '';
  $('#note-title').disabled = true;
  $('#note-folder').textContent = '';
  $('#workspace').classList.add('hidden');
  $('#empty').hidden = false;
  $('#backlinks').replaceChildren();
  $('#unlinked').replaceChildren();
  $('#outline').replaceChildren();
  $('#backlink-count').textContent = $('#unlinked-count').textContent = '';
  document.title = 'Notes';
  if (location.hash) history.replaceState(null, '', location.pathname);
}

function setStatus(text) { $('#save-status').textContent = text; }

function setConflict(on) {
  state.conflict = on;
  $('#conflict').hidden = !on;
}

let saveTimer;
function scheduleSave() {
  state.dirty = true;
  setStatus('Editing…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save().catch(fail), 700);
}

async function save({ force = false } = {}) {
  clearTimeout(saveTimer);
  if (!state.current || (!state.dirty && !force) || (state.conflict && !force)) return;
  if (state.saving) await state.saving;
  if (!state.dirty && !force) return;
  const { path } = state.current;
  const content = editor.value;
  setStatus('Saving…');
  state.saving = api('PUT', '/api/note', { path, content, baseMtime: force ? undefined : state.current.mtime })
    .then((res) => {
      if (state.current?.path !== path) return;
      state.current.mtime = res.mtime;
      state.current.content = content;
      if (editor.value === content) state.dirty = false;
      setStatus(state.dirty ? 'Editing…' : 'Saved');
      if (!state.notes.includes(path)) loadTree();
      scheduleBacklinks();
    })
    .catch((e) => {
      if (e.status === 409) { setConflict(true); setStatus('Not saved'); } else { setStatus('Not saved'); throw e; }
    })
    .finally(() => { state.saving = null; });
  return state.saving;
}

async function flushSave() {
  if (state.dirty && !state.conflict) await save().catch(fail);
  else if (state.saving) await state.saving.catch(() => {});
}

$('#btn-reload').addEventListener('click', async () => {
  if (!state.current) return;
  state.dirty = false;
  setConflict(false);
  await openNote(state.current.path).catch(fail);
});
$('#btn-overwrite').addEventListener('click', async () => {
  setConflict(false);
  await save({ force: true }).catch(fail);
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) {
    save().catch(() => {});
    e.preventDefault();
  }
});

// ---------------------------------------------------------------- preview, outline, backlinks

let previewTimer;
function renderPreview() {
  if (!state.current) return;
  const scroll = preview.scrollTop;
  renderMarkdown(preview, editor.value, { notes: state.notes, files: state.files, notePath: state.current.path });
  loadEmbeds(preview, 0);
  preview.scrollTop = scroll;
}

async function loadEmbeds(root, depth) {
  for (const box of root.querySelectorAll('.embed[data-embed]')) {
    if (depth > 1 || box.dataset.embed === state.current?.path) continue;
    try {
      const { content } = await api('GET', '/api/note' + q({ path: box.dataset.embed }));
      let body = splitFrontmatter(content).body;
      if (box.dataset.heading) body = sectionOf(body, box.dataset.heading) ?? body;
      const inner = el('div');
      renderMarkdown(inner, body, { notes: state.notes, files: state.files, notePath: box.dataset.embed });
      inner.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.disabled = true; delete c.dataset.task; });
      box.append(inner);
      loadEmbeds(inner, depth + 1);
    } catch { /* missing embeds just show their title */ }
  }
}

function sectionOf(body, heading) {
  const hs = headingsOf(body);
  const i = hs.findIndex((h) => slugify(h.text) === slugify(heading));
  if (i < 0) return null;
  const end = hs.slice(i + 1).find((h) => h.level <= hs[i].level);
  return body.slice(hs[i].offset, end ? end.offset : undefined);
}

function renderOutline() {
  const list = $('#outline');
  const hs = state.current ? headingsOf(editor.value) : [];
  list.replaceChildren(...hs.map((h) => {
    const li = el('li', { textContent: h.text, title: h.text });
    li.style.paddingLeft = 6 + (h.level - 1) * 12 + 'px';
    li.addEventListener('click', () => jumpToOffset(h.offset, h.text));
    return li;
  }));
  if (!hs.length) list.append(el('div', { className: 'muted', textContent: state.current ? 'No headings' : '' }));
}

function jumpToOffset(offset, headingText) {
  if (state.mode !== 'preview') {
    editor.focus();
    editor.setSelectionRange(offset, offset);
    // Scroll the caret line into view.
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 24;
    const line = editor.value.slice(0, offset).split('\n').length - 1;
    editor.scrollTop = Math.max(0, line * lineHeight - editor.clientHeight / 3);
  }
  if (state.mode !== 'edit' && headingText) {
    document.getElementById('h-' + slugify(headingText))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function jumpToHeading(heading) {
  const h = headingsOf(editor.value).find((x) => slugify(x.text) === slugify(heading));
  if (h) jumpToOffset(h.offset, h.text);
}

function resultRow(path, snippets = [], highlight = []) {
  const row = el('div', { className: 'result' },
    el('div', { className: 'r-title', textContent: baseName(path) }),
    dirName(path) ? el('div', { className: 'r-path', textContent: dirName(path) }) : null);
  for (const s of snippets.slice(0, 2)) {
    const snip = el('div', { className: 'r-snip' });
    appendHighlighted(snip, s, highlight);
    row.append(snip);
  }
  row.addEventListener('click', () => navigate(path));
  return row;
}

function appendHighlighted(node, text, terms) {
  const t = terms.filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!t.length) { node.textContent = text; return; }
  const re = new RegExp(`(${t.join('|')})`, 'gi');
  text.split(re).forEach((part, i) => node.append(i % 2 ? el('mark', { textContent: part }) : part));
}

let backlinkTimer;
const scheduleBacklinks = () => { clearTimeout(backlinkTimer); backlinkTimer = setTimeout(loadBacklinks, 1500); };

async function loadBacklinks() {
  if (!state.current) return;
  const path = state.current.path;
  const { linked, unlinked } = await api('GET', '/api/backlinks' + q({ path })).catch(() => ({ linked: [], unlinked: [] }));
  if (state.current?.path !== path) return;
  const name = baseName(path);
  $('#backlink-count').textContent = linked.length || '';
  $('#unlinked-count').textContent = unlinked.length || '';
  $('#backlinks').replaceChildren(...(linked.length ? linked.map((b) => resultRow(b.path, b.snippets, [name])) : [el('div', { className: 'muted', textContent: 'No notes link here yet.' })]));
  $('#unlinked').replaceChildren(...(unlinked.length ? unlinked.map((b) => resultRow(b.path, b.snippets, [name])) : [el('div', { className: 'muted', textContent: 'None' })]));
}

// Preview interactions: links, tags, task checkboxes.
preview.addEventListener('click', async (e) => {
  const box = e.target.closest('input[type="checkbox"][data-task]');
  if (box) {
    const next = toggleTaskInSource(editor.value, Number(box.dataset.task));
    editor.value = next;
    scheduleSave();
    renderPreview();
    return;
  }
  const a = e.target.closest('a');
  if (!a) return;
  if (a.classList.contains('wikilink')) {
    e.preventDefault();
    await followLink(a.dataset.target, a.dataset.heading);
  } else if (a.classList.contains('tag')) {
    e.preventDefault();
    showSearch('#' + a.dataset.tag);
  } else {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      e.preventDefault();
      document.getElementById('h-' + slugify(decodeURIComponent(href.slice(1))))?.scrollIntoView({ behavior: 'smooth' });
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      // Relative Markdown link to another note.
      e.preventDefault();
      const [file, heading] = decodeURIComponent(href).split('#');
      const target = resolveLink(joinPath(dirName(state.current.path), file), state.notes) ?? resolveLink(file, state.notes);
      if (target) navigate(target, { heading });
      else toast(`No note at ${file}`);
    }
  }
});

async function followLink(target, heading) {
  const path = resolveLink(target, state.notes);
  if (path) return navigate(path, { heading });
  // Create the missing note, keeping any folder in the link.
  const rel = (target.includes('/') ? target : joinPath(state.config.newNoteFolder, target)).replace(/\.md$/i, '') + '.md';
  const res = await api('POST', '/api/note', { path: rel, content: `# ${baseName(rel)}\n\n` }).catch(async (e) => {
    if (e.status === 409) return { path: rel };
    throw e;
  });
  await flushSave();
  await loadTree();
  renderPreview();
  navigate(res.path, { cursor: baseName(rel).length + 4 });
}

// ---------------------------------------------------------------- editor wiring

setupEditor(editor, $('#suggest'), { getNotes: () => state.notes });

editor.addEventListener('input', () => {
  scheduleSave();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { renderPreview(); renderOutline(); }, 150);
});

// Paste or drop images: save them into the vault and insert an embed.
async function attachFiles(fileList) {
  for (const file of fileList) {
    let name = file.name || 'Pasted image.png';
    if (/^image\.\w+$/i.test(name)) {
      const ext = name.split('.').pop();
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
      name = `Pasted image ${stamp}.${ext}`;
    }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const res = await api('POST', '/api/attachment', { name, data });
    state.files.push(res.path);
    insertText(editor, `![[${res.path.split('/').pop()}]]\n`);
  }
}
editor.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  attachFiles(files).catch(fail);
});
editor.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
editor.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  attachFiles(files).catch(fail);
});

// Rename via the title field.
const titleInput = $('#note-title');
titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); editor.focus(); }
  if (e.key === 'Escape') { titleInput.value = baseName(state.current.path); editor.focus(); }
});
titleInput.addEventListener('blur', async () => {
  if (!state.current) return;
  const name = titleInput.value.trim().replace(/[\\/:*?"<>|#^[\]]/g, '-');
  if (!name || name === baseName(state.current.path)) { titleInput.value = baseName(state.current.path); return; }
  await moveItem(state.current.path, joinPath(dirName(state.current.path), name + '.md')).catch((e) => {
    titleInput.value = baseName(state.current.path);
    fail(e);
  });
});

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('mode', mode);
  const ws = $('#workspace');
  ws.classList.remove('mode-edit', 'mode-split', 'mode-preview');
  ws.classList.add('mode-' + mode);
  document.querySelectorAll('.segmented button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode !== 'preview' && state.current) editor.focus();
}
document.querySelectorAll('.segmented button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------------------------------------------------------------- note actions

async function newNote(folder) {
  await flushSave();
  const res = await api('POST', '/api/note', { folder: folder ?? currentFolderDefault(), title: 'Untitled', content: '' });
  await loadTree();
  navigate(res.path);
  setTimeout(() => { titleInput.focus(); titleInput.select(); }, 50);
}

// New notes go next to the open note when it's in a regular folder; otherwise the configured folder.
function currentFolderDefault() {
  const dir = state.current ? dirName(state.current.path) : '';
  if (!state.current || isTemplate(state.current.path)) return state.config.newNoteFolder || '';
  return dir || state.config.newNoteFolder || '';
}

async function newFromTemplate(folder) {
  const templates = await api('GET', '/api/templates');
  if (!templates.length) {
    toast(`No templates yet — add notes to the "${state.templatesFolder}" folder`, 4000);
    return;
  }
  palette({
    placeholder: 'Choose a template…',
    hint: `Templates live in the "${state.templatesFolder}" folder · Enter to use`,
    source: (query) => templates
      .map((t) => ({ t, score: fuzzyScore(query, t.name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ t }) => ({
        label: t.name,
        detail: [t.folderPattern && `→ ${t.folderPattern}`, t.prompts.length && `asks ${t.prompts.length} question${t.prompts.length > 1 ? 's' : ''}`].filter(Boolean).join(' · '),
        run: () => fillTemplate(t, folder),
      })),
  });
}

async function fillTemplate(t, folder) {
  const fields = [];
  if (!t.namePattern) fields.push({ name: '__title', label: 'Title', value: '', placeholder: t.name, required: true });
  for (const p of t.prompts) fields.push({ name: p.label, label: p.label, value: p.default, placeholder: p.default });
  if (t.namePattern) fields.push({ name: '__title', label: 'Title (optional)', value: '', placeholder: t.namePattern, help: 'Leave empty to name it automatically.' });

  let answers = {};
  if (fields.length) {
    answers = await formDialog({ title: `New ${t.name}`, fields, okLabel: 'Create' });
    if (!answers) return;
  }
  const { __title: title = '', ...rest } = answers;
  await flushSave();
  const res = await api('POST', '/api/from-template', {
    template: t.path,
    title,
    answers: rest,
    folder: folder || undefined,
  });
  await loadTree();
  navigate(res.path, { cursor: res.cursor });
}

async function openDaily() {
  await flushSave();
  const res = await api('POST', '/api/daily');
  if (res.created) await loadTree();
  navigate(res.path, { cursor: res.created ? res.cursor : undefined });
}

async function newFolder(parent = '') {
  const r = await formDialog({ title: 'New folder', fields: [{ name: 'name', label: parent ? `Inside ${parent}` : 'Folder name', required: true }], okLabel: 'Create' });
  if (!r?.name.trim()) return;
  const path = joinPath(parent, r.name.trim().replace(/[\\:*?"<>|]/g, '-'));
  await api('POST', '/api/folder', { path });
  state.openFolders.add(path);
  state.openFolders.add(parent);
  await loadTree();
}

async function moveItem(from, to) {
  await flushSave();
  const res = await api('POST', '/api/rename', { from, to });
  // Keep folder expansion state and the open note in sync with the new location.
  for (const f of [...state.openFolders]) {
    if (f === from || f.startsWith(from + '/')) { state.openFolders.delete(f); state.openFolders.add(res.path + f.slice(from.length)); }
  }
  await loadTree();
  if (res.updated.length) toast(`Updated links in ${res.updated.length} note${res.updated.length > 1 ? 's' : ''}`);
  const cur = state.current?.path;
  if (cur && (cur === from || cur.startsWith(from + '/'))) {
    const next = cur === from ? res.path : res.path + cur.slice(from.length);
    state.current = null;
    navigate(next);
  } else if (cur && res.updated.includes(cur)) {
    await openNote(cur);
  } else {
    renderPreview();
  }
}

async function renameItem(path, isFolder) {
  const current = isFolder ? path.split('/').pop() : baseName(path);
  const r = await formDialog({ title: isFolder ? 'Rename folder' : 'Rename note', fields: [{ name: 'name', label: 'Name', value: current, required: true }], okLabel: 'Rename', message: 'Links to it will be updated.' });
  if (!r || !r.name.trim() || r.name.trim() === current) return;
  const name = r.name.trim().replace(/[\\/:*?"<>|]/g, '-');
  await moveItem(path, joinPath(dirName(path), isFolder ? name : name + '.md'));
}

async function deleteItem(path, isFolder) {
  const ok = await confirmDialog(isFolder ? 'Delete folder?' : 'Delete note?',
    `"${isFolder ? path : baseName(path)}"${isFolder ? ' and everything in it' : ''} will be moved to the vault's .trash folder.`);
  if (!ok) return;
  if (state.current && (state.current.path === path || state.current.path.startsWith(path + '/'))) {
    clearTimeout(saveTimer);
    state.dirty = false;
    showEmpty();
  }
  await api('DELETE', '/api/note' + q({ path }));
  await loadTree();
  toast('Moved to .trash');
}

async function duplicateNote(path) {
  const { content } = await api('GET', '/api/note' + q({ path }));
  const res = await api('POST', '/api/note', { folder: dirName(path), title: baseName(path) + ' copy', content });
  await loadTree();
  navigate(res.path);
}

function quickSwitcher() {
  palette({
    placeholder: 'Find or create a note…',
    hint: '↑↓ to navigate · Enter to open · type a new name to create it',
    source: (query) => {
      const items = state.notes
        .map((p) => ({ p, score: Math.max(fuzzyScore(query, baseName(p)), fuzzyScore(query, p) - 100) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 50)
        .map(({ p }) => ({ label: baseName(p), detail: dirName(p), run: () => navigate(p) }));
      const name = query.trim();
      if (name && !state.notes.some((p) => baseName(p).toLowerCase() === name.toLowerCase())) {
        items.push({ label: `Create "${name}"`, detail: 'new note', run: () => followLink(name) });
      }
      return items;
    },
  });
}

async function openSettings() {
  const [config, templates] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/templates')]);
  const r = await formDialog({
    title: 'Settings',
    message: `Vault: ${config.vaultPath}`,
    okLabel: 'Save',
    fields: [
      { name: 'templatesFolder', label: 'Templates folder', value: config.templatesFolder },
      { name: 'dailyFolder', label: 'Daily notes folder', value: config.dailyFolder },
      {
        name: 'dailyTemplate', label: 'Daily note template', type: 'select', value: config.dailyTemplate,
        options: [{ value: '', label: '(none)' }, ...templates.map((t) => ({ value: t.name, label: t.name }))],
      },
      { name: 'dailyNameFormat', label: 'Daily note name format', value: config.dailyNameFormat, help: 'e.g. YYYY-MM-DD or YYYY/MM/YYYY-MM-DD dddd' },
      { name: 'newNoteFolder', label: 'Default folder for new notes', value: config.newNoteFolder, placeholder: '(vault root)' },
      { name: 'attachmentsFolder', label: 'Folder for pasted images', value: config.attachmentsFolder },
    ],
  });
  if (!r) return;
  state.config = await api('PUT', '/api/config', r);
  await loadTree();
  toast('Settings saved');
}

// ---------------------------------------------------------------- search & tags

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === 'tags') loadTags();
  if (name === 'search') $('#search-input').focus();
  $('#app').classList.add('show-left');
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function showSearch(query) {
  showTab('search');
  $('#search-input').value = query;
  runSearch();
}

let searchTimer;
let searchSeq = 0;
async function runSearch() {
  const query = $('#search-input').value;
  const seq = ++searchSeq;
  const out = $('#search-results');
  if (!query.trim()) { out.replaceChildren(); return; }
  const results = await api('GET', '/api/search' + q({ q: query })).catch(fail);
  if (seq !== searchSeq || !results) return;
  const terms = query.trim().split(/\s+/);
  out.replaceChildren(...(results.length ? results.map((r) => resultRow(r.path, r.snippets, terms)) : [el('div', { className: 'muted', textContent: 'No matches' })]));
}
$('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });

async function loadTags() {
  const tags = await api('GET', '/api/tags').catch(fail);
  if (!tags) return;
  const list = $('#tag-list');
  list.replaceChildren(...tags.map(({ tag, count }) => {
    const b = el('button', { className: 'tag-chip' }, '#' + tag, el('span', { className: 'count', textContent: count }));
    b.addEventListener('click', () => showSearch('#' + tag));
    return b;
  }));
  if (!tags.length) list.append(el('div', { className: 'muted', textContent: 'No tags yet. Add #tags to your notes.' }));
}

// ---------------------------------------------------------------- live updates

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('change', async (e) => {
    const { paths } = JSON.parse(e.data);
    await loadTree().catch(() => {});
    const cur = state.current?.path;
    if (!cur || !paths.includes(cur)) return;
    if (!state.notes.includes(cur)) { toast('The open note was moved or deleted outside the app'); return; }
    const fresh = await api('GET', '/api/note' + q({ path: cur })).catch(() => null);
    if (!fresh || fresh.content === editor.value) { if (fresh) state.current.mtime = fresh.mtime; return; }
    if (state.dirty) { setConflict(true); return; }
    const pos = editor.selectionStart;
    state.current = fresh;
    editor.value = fresh.content;
    editor.setSelectionRange(Math.min(pos, fresh.content.length), Math.min(pos, fresh.content.length));
    renderPreview();
    renderOutline();
  });
}

// ---------------------------------------------------------------- shortcuts & buttons

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.shiftKey && key === 'o') { e.preventDefault(); quickSwitcher(); }
  else if (mod && !e.shiftKey && key === 's') { e.preventDefault(); save().then(() => { if (!state.dirty && state.current) setStatus('Saved'); }).catch(fail); }
  else if (mod && !e.shiftKey && key === 'e') { e.preventDefault(); setMode(state.mode === 'edit' ? 'preview' : state.mode === 'preview' ? 'split' : 'edit'); }
  else if (mod && e.shiftKey && key === 'f') { e.preventDefault(); showTab('search'); $('#search-input').select(); }
  else if (e.altKey && !mod && e.code === 'KeyN') { e.preventDefault(); newNote().catch(fail); }
  else if (e.altKey && !mod && e.code === 'KeyT') { e.preventDefault(); newFromTemplate().catch(fail); }
  else if (e.altKey && !mod && e.code === 'KeyD') { e.preventDefault(); openDaily().catch(fail); }
  else if (e.key === 'Escape') hideContextMenu();
});

$('#btn-new').addEventListener('click', () => newNote().catch(fail));
$('#btn-template').addEventListener('click', () => newFromTemplate().catch(fail));
$('#btn-daily').addEventListener('click', () => openDaily().catch(fail));
$('#btn-folder').addEventListener('click', () => newFolder().catch(fail));
$('#empty-new').addEventListener('click', () => newNote().catch(fail));
$('#empty-template').addEventListener('click', () => newFromTemplate().catch(fail));
$('#empty-daily').addEventListener('click', () => openDaily().catch(fail));
$('#btn-settings').addEventListener('click', () => openSettings().catch(fail));
$('#btn-toggle-right').addEventListener('click', () => {
  const on = $('#app').classList.toggle('show-right');
  localStorage.setItem('showRight', on ? '1' : '0');
});
$('#btn-toggle-left').addEventListener('click', () => $('#app').classList.toggle('show-left'));
$('#btn-theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  localStorage.setItem('theme', document.documentElement.dataset.theme);
});

window.addEventListener('hashchange', () => {
  const path = decodeURIComponent(location.hash.replace(/^#\//, ''));
  if (path) openNote(path).catch(fail);
});
window.addEventListener('focus', () => { loadTree().catch(() => {}); });

// ---------------------------------------------------------------- boot

(async function boot() {
  const wide = window.innerWidth > 900;
  $('#app').classList.toggle('show-right', wide && localStorage.getItem('showRight') !== '0');
  setMode(state.mode);
  setupDragAndDrop();
  try {
    state.config = await api('GET', '/api/config');
    const vaultName = state.config.vaultPath.split(/[\\/]/).filter(Boolean).pop() || 'Notes';
    $('#vault-name').textContent = vaultName;
    $('#vault-name').title = state.config.vaultPath;
    await loadTree();
  } catch (e) {
    fail(e);
    return;
  }
  connectEvents();
  const fromHash = decodeURIComponent(location.hash.replace(/^#\//, ''));
  const last = localStorage.getItem('lastNote');
  const start = fromHash || (last && state.notes.includes(last) ? last : state.notes.find((p) => baseName(p) === 'Welcome'));
  if (start) {
    if (fromHash) await openNote(start).catch(fail);
    else navigate(start);
  } else {
    showEmpty();
  }
})();
