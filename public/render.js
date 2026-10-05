import { Marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { resolveLink } from '/shared/markdown.js';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

export const slugify = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fileUrl = (path) => '/vault-file/' + path.split('/').map(encodeURIComponent).join('/');

// Context for the current render: the note being shown and all vault paths.
let ctx = { notes: [], files: [], notePath: '' };

// Finds an attachment by name (Obsidian style) or by path relative to the note or vault.
export function resolveFile(ref, notePath, files) {
  const clean = decodeURIComponent(ref).replace(/^\.\//, '');
  const dir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/') + 1) : '';
  const lower = files.map((f) => f.toLowerCase());
  for (const candidate of [dir + clean, clean]) {
    const normalized = normalizePath(candidate).toLowerCase();
    const i = lower.indexOf(normalized);
    if (i >= 0) return files[i];
  }
  if (!clean.includes('/')) {
    const i = lower.findIndex((f) => f.split('/').pop() === clean.toLowerCase());
    if (i >= 0) return files[i];
  }
  return null;
}

function normalizePath(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: [{
    name: 'wikilink',
    level: 'inline',
    start(src) { const i = src.search(/!?\[\[/); return i < 0 ? undefined : i; },
    tokenizer(src) {
      const m = /^(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/.exec(src);
      if (!m) return undefined;
      return { type: 'wikilink', raw: m[0], embed: !!m[1], target: m[2].trim(), heading: m[3]?.slice(1).trim() ?? '', alias: m[4]?.trim() };
    },
    renderer(t) {
      if (t.embed && IMAGE_RE.test(t.target)) {
        const file = resolveFile(t.target, ctx.notePath, ctx.files);
        const size = /^\d+(x\d+)?$/.test(t.alias ?? '') ? t.alias.split('x') : [];
        const dims = (size[0] ? ` width="${size[0]}"` : '') + (size[1] ? ` height="${size[1]}"` : '');
        return file ? `<img src="${escapeHtml(fileUrl(file))}" alt="${escapeHtml(t.target)}"${dims}>` : `<span class="muted">Missing image: ${escapeHtml(t.target)}</span>`;
      }
      const path = resolveLink(t.target, ctx.notes);
      if (t.embed && path) {
        return `<div class="embed" data-embed="${escapeHtml(path)}" data-heading="${escapeHtml(t.heading)}"><div class="embed-title">${escapeHtml(t.target)}</div></div>`;
      }
      const label = t.alias || (t.heading ? `${t.target} › ${t.heading}` : t.target);
      return `<a href="#" class="wikilink${path ? '' : ' missing'}" data-target="${escapeHtml(t.target)}" data-heading="${escapeHtml(t.heading)}"${path ? ` title="${escapeHtml(path)}"` : ' title="Click to create"'}>${escapeHtml(label)}</a>`;
    },
  }],
  renderer: {
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      const text = html.replace(/<[^>]+>/g, '');
      return `<h${depth} id="h-${escapeHtml(slugify(text))}">${html}</h${depth}>\n`;
    },
  },
});

export function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: null, body: text, offset: 0 };
  const data = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) data.push([kv[1], kv[2]]);
    else if (data.length && line.trim()) data[data.length - 1][1] += ' ' + line.trim();
  }
  return { data, body: text.slice(m[0].length), offset: m[0].length };
}

function linkifyTags(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.includes('#')) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(TAG_RE)) {
      const start = m.index + m[1].length;
      frag.append(text.slice(last, start));
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'tag';
      a.dataset.tag = m[2].toLowerCase();
      a.textContent = '#' + m[2];
      frag.append(a);
      last = start + 1 + m[2].length;
    }
    if (last === 0) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

// Renders note Markdown into `el`. Returns nothing; interactive bits are wired by the caller.
export function renderMarkdown(el, text, { notes, files, notePath }) {
  ctx = { notes, files, notePath };
  const { data, body } = splitFrontmatter(text);
  let html = '';
  if (data && data.length) {
    html += '<dl class="frontmatter">' + data.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('') + '</dl>';
  }
  html += marked.parse(body);
  el.innerHTML = DOMPurify.sanitize(html);
  linkifyTags(el);

  el.querySelectorAll('input[type="checkbox"]').forEach((box, i) => {
    box.disabled = false;
    box.dataset.task = String(i);
    const li = box.closest('li');
    if (li) { li.classList.add('task'); li.classList.toggle('done', box.checked); }
  });
  el.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  });
  el.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(src)) return;
    const file = resolveFile(src, notePath, files);
    if (file) img.src = fileUrl(file);
  });
}

// Finds the source offset of the Nth task checkbox so preview clicks can edit the text.
export function toggleTaskInSource(text, index) {
  const re = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm;
  let fence = null;
  let count = 0;
  let pos = 0;
  for (const line of text.split('\n')) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) fence = fence === f[1] ? null : fence ?? f[1];
    else if (!fence) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) {
        if (count === index) {
          const at = pos + m[1].length;
          return text.slice(0, at) + (m[2] === ' ' ? 'x' : ' ') + text.slice(at + 1);
        }
        count++;
      }
    }
    pos += line.length + 1;
  }
  return text;
}

export function headingsOf(text) {
  const { body, offset } = splitFrontmatter(text);
  const out = [];
  let fence = null;
  let pos = offset;
  for (const line of body.split('\n')) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) fence = fence === f[1] ? null : fence ?? f[1];
    else if (!fence) {
      const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) out.push({ level: m[1].length, text: m[2], offset: pos });
    }
    pos += line.length + 1;
  }
  return out;
}
