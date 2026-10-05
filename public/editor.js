// Editing helpers for the Markdown textarea: list continuation, indentation,
// and the [[link]] suggestion popup.

// Inserts text through the browser's editing pipeline so Ctrl+Z still works.
export function insertText(ta, text, start = ta.selectionStart, end = ta.selectionEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

const lineStart = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (text, pos) => { const i = text.indexOf('\n', pos); return i < 0 ? text.length : i; };

// Enter inside a list continues it; Enter on an empty item ends it.
function continueList(ta) {
  const { value, selectionStart: pos, selectionEnd } = ta;
  if (pos !== selectionEnd) return false;
  const start = lineStart(value, pos);
  const line = value.slice(start, pos);
  const m = line.match(/^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/);
  if (!m) {
    const quote = line.match(/^(\s*>\s?)/);
    if (quote && line.trim() !== '>') { insertText(ta, '\n' + quote[1]); return true; }
    return false;
  }
  if (line.slice(m[0].length).trim() === '' && pos === lineEnd(value, pos)) {
    insertText(ta, '', start, pos); // empty item: leave the list
    return true;
  }
  const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
  insertText(ta, `\n${m[1]}${marker}${m[5]}${m[6] ? '[ ] ' : ''}`);
  return true;
}

function indent(ta, outdent) {
  const { value, selectionStart: s, selectionEnd: e } = ta;
  const start = lineStart(value, s);
  const end = lineEnd(value, e);
  const isList = /^\s*([-*+]|\d+[.)])\s/.test(value.slice(start, end));
  if (s === e && !outdent && !isList) { insertText(ta, '  '); return; }
  const lines = value.slice(start, end).split('\n');
  const next = lines.map((l) => (outdent ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l)).join('\n');
  insertText(ta, next, start, end);
  const delta = next.length - (end - start);
  if (lines.length === 1 && s === e) ta.setSelectionRange(Math.max(start, s + delta), Math.max(start, s + delta));
  else ta.setSelectionRange(start, start + next.length);
}

function wrap(ta, before, after = before) {
  const { value, selectionStart: s, selectionEnd: e } = ta;
  const selected = value.slice(s, e);
  insertText(ta, before + selected + after, s, e);
  ta.setSelectionRange(s + before.length, e + before.length);
}

// Pixel position of the caret inside a textarea, via an off-screen mirror element.
export function caretPosition(ta) {
  const style = getComputedStyle(ta);
  const mirror = document.createElement('div');
  for (const p of ['boxSizing', 'width', 'padding', 'border', 'font', 'letterSpacing', 'lineHeight', 'tabSize', 'textIndent', 'wordSpacing']) {
    mirror.style[p] = style[p];
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '-9999px' });
  mirror.textContent = ta.value.slice(0, ta.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.append(marker);
  document.body.append(mirror);
  const pos = { left: marker.offsetLeft, top: marker.offsetTop - ta.scrollTop, height: parseFloat(style.lineHeight) || 20 };
  mirror.remove();
  return pos;
}

// Simple fuzzy scorer: all query chars must appear in order. Higher is better.
export function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 2 - t.length * 0.1 + (idx === 0 || /[\s/_-]/.test(t[idx - 1]) ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score - t.length * 0.1;
}

// Wires up keyboard behaviour and the [[ suggestion popup.
// `getNotes` returns note paths; `onChange` runs after programmatic edits.
export function setupEditor(ta, popup, { getNotes }) {
  let items = [];
  let selected = 0;
  let range = null; // { start, end } of the text after "[["

  const close = () => { popup.hidden = true; range = null; };

  function update() {
    const pos = ta.selectionStart;
    const before = ta.value.slice(lineStart(ta.value, pos), pos);
    const m = before.match(/\[\[([^\]\[|#\n]*)$/);
    if (!m || ta.selectionStart !== ta.selectionEnd) return close();
    const query = m[1];
    range = { start: pos - query.length, end: pos };
    items = getNotes()
      .map((p) => ({ path: p, name: p.split('/').pop().replace(/\.md$/i, '') }))
      .map((n) => ({ ...n, score: Math.max(fuzzyScore(query, n.name), fuzzyScore(query, n.path) - 50) }))
      .filter((n) => n.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    if (query.trim() && !items.some((n) => n.name.toLowerCase() === query.trim().toLowerCase())) {
      items.push({ name: query.trim(), path: null });
    }
    if (!items.length) return close();
    selected = Math.min(selected, items.length - 1);
    popup.replaceChildren(...items.map((it, i) => {
      const div = document.createElement('div');
      div.className = i === selected ? 'sel' : '';
      div.textContent = it.name;
      const small = document.createElement('small');
      small.textContent = it.path ? (it.path.includes('/') ? it.path.slice(0, it.path.lastIndexOf('/')) : '') : 'new note';
      div.append(small);
      div.addEventListener('mousedown', (e) => { e.preventDefault(); selected = i; accept(); });
      return div;
    }));
    const caret = caretPosition(ta);
    popup.style.left = Math.min(caret.left, ta.clientWidth - 260) + 'px';
    popup.style.top = caret.top + caret.height + 4 + 'px';
    popup.hidden = false;
  }

  function accept() {
    const it = items[selected];
    if (!it || !range) return close();
    // Use the shortest unambiguous name: the file name unless another note shares it.
    const sameName = getNotes().filter((p) => p.split('/').pop().replace(/\.md$/i, '').toLowerCase() === it.name.toLowerCase());
    const target = it.path && sameName.length > 1 ? it.path.replace(/\.md$/i, '') : it.name;
    const hasClose = ta.value.slice(range.end, range.end + 2) === ']]';
    insertText(ta, target + ']]', range.start, range.end + (hasClose ? 2 : 0));
    close();
  }

  ta.addEventListener('input', () => { selected = 0; update(); });
  ta.addEventListener('blur', () => setTimeout(close, 100));
  ta.addEventListener('click', update);

  ta.addEventListener('keydown', (e) => {
    if (!popup.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        [...popup.children].forEach((c, i) => c.classList.toggle('sel', i === selected));
        popup.children[selected]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(); return; }
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey && !e.isComposing) {
      if (continueList(ta)) e.preventDefault();
    } else if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      indent(ta, e.shiftKey);
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault(); wrap(ta, '**');
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault(); wrap(ta, '*');
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault(); wrap(ta, '[[', ']]');
    } else if (e.key === '[' && !mod && ta.selectionStart !== ta.selectionEnd) {
      e.preventDefault(); wrap(ta, '[', ']');
    }
  });
}
