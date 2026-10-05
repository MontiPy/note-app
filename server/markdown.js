// Link and tag extraction shared by the server index. Kept free of Node APIs.

// Removes fenced and inline code so links/tags inside code are ignored.
export function stripCode(text) {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

// [[Target]], [[Target|alias]], [[Target#Heading]], ![[Embed]]
export function extractLinks(text) {
  const links = [];
  for (const m of stripCode(text).matchAll(/!?\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    links.push(m[1].trim());
  }
  return links;
}

export function extractTags(text) {
  const tags = new Set();
  const body = stripCode(text);
  for (const m of body.matchAll(/(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
    tags.add(m[2].toLowerCase());
  }
  // Frontmatter: `tags: [a, b]`, `tags: a, b` or a YAML list.
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const inline = fm[1].match(/^tags:[ \t]*\[?([^\]\n]+)\]?[ \t]*$/m);
    if (inline) inline[1].split(',').forEach((t) => t.trim() && tags.add(t.trim().replace(/^#/, '').toLowerCase()));
    const list = fm[1].match(/^tags:[ \t]*\r?\n((?:[ \t]*-[ \t]*.+\r?\n?)+)/m);
    if (list) list[1].split(/\r?\n/).forEach((l) => {
      const t = l.replace(/^[ \t]*-[ \t]*/, '').trim();
      if (t) tags.add(t.replace(/^#/, '').toLowerCase());
    });
  }
  return [...tags];
}

const baseName = (p) => p.split('/').pop().replace(/\.md$/i, '');

// Resolves a wiki-link target to a note path. Matches "Folder/Name" against the
// path, otherwise "Name" against file names; the shortest path wins ties.
export function resolveLink(target, paths) {
  const t = target.trim().replace(/\.md$/i, '').toLowerCase();
  if (!t) return null;
  const candidates = paths.filter((p) => {
    const noExt = p.replace(/\.md$/i, '').toLowerCase();
    return t.includes('/') ? noExt === t || noExt.endsWith('/' + t) : baseName(p).toLowerCase() === t;
  });
  candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  return candidates[0] ?? null;
}

// Rewrites links pointing at `oldPath` so they point at `newPath`.
export function rewriteLinks(text, oldPath, newPath, paths) {
  const newTarget = baseName(newPath);
  return text.replace(/(!?\[\[)([^\]|#\n]+)((?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\])/g, (whole, open, target, rest) => {
    if (resolveLink(target, paths) !== oldPath) return whole;
    const keepFolder = target.includes('/') ? newPath.replace(/\.md$/i, '') : newTarget;
    return open + keepFolder + rest;
  });
}
