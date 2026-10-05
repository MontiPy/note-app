// Template engine. Templates are ordinary Markdown files with {{placeholders}}.
//
//   {{title}}                    title of the new note
//   {{date}} / {{time}}          today as YYYY-MM-DD / now as HH:mm
//   {{date:dddd, MMMM D}}        custom format (YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm ss A a, [literal])
//   {{date+1d}} {{date-1w:...}}  date offsets in d(ays) w(eeks) m(onths) y(ears)
//   {{yesterday}} {{tomorrow}}   shorthands for {{date-1d}} / {{date+1d}}
//   {{prompt:Label}}             asks for a value when the note is created
//   {{prompt:Label|default}}     ...with a default value
//   {{cursor}}                   where the cursor lands after creation
//
// Frontmatter keys starting with "template-" configure the template itself and
// are stripped from the new note:
//   template-name:   file name pattern, e.g. "{{date}} {{prompt:Meeting}}"
//   template-folder: folder for new notes, e.g. "Meetings/{{date:YYYY}}"

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatDate(d, fmt = 'YYYY-MM-DD') {
  const h12 = d.getHours() % 12 || 12;
  const tokens = {
    YYYY: () => String(d.getFullYear()),
    YY: () => pad(d.getFullYear() % 100),
    MMMM: () => MONTHS[d.getMonth()],
    MMM: () => MONTHS[d.getMonth()].slice(0, 3),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => DAYS[d.getDay()],
    ddd: () => DAYS[d.getDay()].slice(0, 3),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    hh: () => pad(h12),
    h: () => String(h12),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    A: () => (d.getHours() < 12 ? 'AM' : 'PM'),
    a: () => (d.getHours() < 12 ? 'am' : 'pm'),
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a/g,
    (m, literal) => (literal !== undefined ? literal : tokens[m]()));
}

export function shiftDate(d, offset) {
  const r = new Date(d);
  if (!offset) return r;
  const n = parseInt(offset.slice(0, -1), 10);
  switch (offset.slice(-1)) {
    case 'd': r.setDate(r.getDate() + n); break;
    case 'w': r.setDate(r.getDate() + 7 * n); break;
    case 'm': r.setMonth(r.getMonth() + n); break;
    case 'y': r.setFullYear(r.getFullYear() + n); break;
  }
  return r;
}

const PROMPT_RE = /\{\{\s*prompt:([^}|]+?)\s*(?:\|([^}]*))?\}\}/g;

// Splits leading YAML frontmatter into template settings and the remaining text.
export function splitTemplateMeta(text) {
  const meta = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta, body: text };
  const kept = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^template-([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    else kept.push(line);
  }
  const rest = text.slice(m[0].length);
  const hasFrontmatter = kept.some((l) => l.trim() !== '');
  const body = hasFrontmatter ? `---\n${kept.join('\n')}\n---\n${rest}` : rest.replace(/^\r?\n/, '');
  return { meta, body };
}

// Lists the questions a template will ask, de-duplicated by label.
export function templatePrompts(text) {
  const seen = new Map();
  for (const m of text.matchAll(PROMPT_RE)) {
    const label = m[1].trim();
    if (!seen.has(label)) seen.set(label, { label, default: (m[2] ?? '').trim() });
  }
  return [...seen.values()];
}

export function describeTemplate(text) {
  const { meta } = splitTemplateMeta(text);
  return { prompts: templatePrompts(text), namePattern: meta.name || null, folderPattern: meta.folder || null };
}

function substitute(text, { title, now, answers }) {
  return text
    .replace(PROMPT_RE, (_, label, def) => {
      const v = answers[label.trim()];
      return v !== undefined && v !== '' ? v : (def ?? '').trim();
    })
    .replace(/\{\{\s*(date|time)([+-]\d+[dwmy])?(?::([^}]*))?\s*\}\}/g, (_, kind, offset, fmt) =>
      formatDate(shiftDate(now, offset), fmt ?? (kind === 'date' ? 'YYYY-MM-DD' : 'HH:mm')))
    .replace(/\{\{\s*yesterday\s*\}\}/g, () => formatDate(shiftDate(now, '-1d')))
    .replace(/\{\{\s*tomorrow\s*\}\}/g, () => formatDate(shiftDate(now, '+1d')))
    .replace(/\{\{\s*title\s*\}\}/g, () => title);
}

export function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
}

// Renders a template into { title, folder, content, cursor }.
// `cursor` is the character offset of {{cursor}} (or -1 when absent).
export function renderTemplate(text, { title = '', now = new Date(), answers = {}, folder } = {}) {
  const { meta, body } = splitTemplateMeta(text);
  let finalTitle = title.trim();
  if (!finalTitle && meta.name) finalTitle = substitute(meta.name, { title: '', now, answers });
  finalTitle = sanitizeFileName(finalTitle) || 'Untitled';

  let finalFolder = folder;
  if (finalFolder === undefined || finalFolder === null) {
    finalFolder = meta.folder ? substitute(meta.folder, { title: finalTitle, now, answers }) : '';
  }
  finalFolder = finalFolder.split('/').map(sanitizeFileName).filter(Boolean).join('/');

  let content = substitute(body, { title: finalTitle, now, answers });
  const cursorMatch = content.match(/\{\{\s*cursor\s*\}\}/);
  const cursor = cursorMatch ? cursorMatch.index : -1;
  content = content.replace(/\{\{\s*cursor\s*\}\}/g, '');
  return { title: finalTitle, folder: finalFolder, content, cursor };
}
