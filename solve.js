// Fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly what makefun-site 1.0.0's build returns for the same
// input, byte for byte, but faster. The pipeline mirrors the reference one plugin
// by plugin, in the same order, with the same report strings. The speed comes from:
// a single-pass Markdown renderer with bulk escaping, templates compiled to plain
// JS functions once per run() call, front matter read by slicing instead of
// splitting and joining the whole file, and allocation-free helpers where the
// reference allocates (token arrays, per-character escaping, per-item scopes).

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_ALL = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Strings without any of them are returned as-is. */
export function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  return text.replace(ESCAPE_ALL, (c) => ESCAPES[c]);
}

/** Whether `text` holds only ASCII code units: NFKD is the identity on those. */
const ASCII_TEST = /^[\x00-\x7F]*$/;

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 */
export function slugify(text) {
  const plain = ASCII_TEST.test(text) ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whitespace code units below 128, for word counting. */
const WS_TAB = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_TAB[c] = 1;

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Only the front matter lines are
 * walked; the body is sliced out, never split and joined back.
 */
export function parseFrontMatter(text) {
  let e = text.indexOf('\n');
  let end = e === -1 ? text.length : e;
  if (text.slice(0, end) !== '---') return { error: 'no front matter' };
  let pos = end === text.length ? text.length : end + 1;
  let idx = 1;
  let closeEnd = -1;
  const fmLines = [];
  while (true) {
    if (pos > text.length) break;
    e = text.indexOf('\n', pos);
    end = e === -1 ? text.length : e;
    const line = text.slice(pos, end);
    if (line === '---') {
      closeEnd = end;
      break;
    }
    fmLines.push({ n: idx + 1, text: line });
    idx++;
    if (e === -1) break;
    pos = e + 1;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (const { n, text: line } of fmLines) {
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${n} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const WS_TEST = /\s/;
const WS_CHAR = /\s/;

/** Whether `line` is blank: empty, or spaces and tabs only. */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null: three backticks, a language of [A-Za-z0-9_+-]*, then spaces or tabs only. */
function fenceOpenOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length || (line.charCodeAt(h) !== 32 && line.charCodeAt(h) !== 9)) return null;
  let j = h;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === j) return null;
  return { depth: h, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet list line's item text, or null: - or * followed by one space. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered list line's number and item text, or null: 1 to 9 digits, ". ", text. */
function orderedOf(line) {
  let d = 0;
  while (d < line.length && d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0) return null;
  if (d === 9 && line.length > 9 && line.charCodeAt(9) >= 48 && line.charCodeAt(9) <= 57) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { num: line.slice(0, d), text: line.slice(d + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !WS_CHAR.test(line[k]);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (line === '' || c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpenOf(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
function isEscapable(c) {
  return (
    c === '\\' || c === '`' || c === '*' || c === '_' || c === '[' || c === ']' || c === '(' ||
    c === ')' || c === '#' || c === '+' || c === '-' || c === '.' || c === '!' || c === '>'
  );
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` is a link's href. Plain runs between
 * specials are appended untouched: they hold nothing to escape. Mirrors the
 * reference's inline() character for character, including what a construct
 * without its closer leaves literal. Builds the string with += : for the short
 * strings here that beats an array plus join.
 */
function inlineStr(s, link) {
  const re = /[\\`*\[&<>"']/g;
  let out = '';
  let start = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      if (i + 1 < s.length && isEscapable(s[i + 1])) {
        out += s.slice(start, i);
        const e2 = s[i + 1];
        out += e2 === '>' ? '&gt;' : e2;
        re.lastIndex = i + 2;
        start = i + 2;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += s.slice(start, i);
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        re.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += s.slice(start, i);
          out += `<strong>${inlineStr(s.slice(i + 2, j), link)}</strong>`;
          re.lastIndex = j + 2;
          start = j + 2;
        } else {
          // No closer: both stars stay literal, and the second must not open
          // an emphasis the reference never opens.
          re.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += s.slice(start, i);
        out += `<em>${inlineStr(s.slice(i + 1, j), link)}</em>`;
        re.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_TEST.test(target)) {
        out += s.slice(start, i);
        out += `<a href="${escapeHtml(link(target))}">${inlineStr(s.slice(i + 1, k), link)}</a>`;
        re.lastIndex = mm + 1;
        start = mm + 1;
      }
      continue;
    }
    out += s.slice(start, i);
    out += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    start = i + 1;
  }
  out += s.slice(start);
  return out;
}

/**
 * `src` rendered in one pass over its lines, no token objects: its HTML (each
 * block on its own lines, a "\n" after the last), its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML), its excerpt (the
 * first paragraph's inline HTML, or "") and its word count (the runs of
 * characters other than whitespace; a word never spans a line, so the lines'
 * counts add up to the body's).
 */
export function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let words = 0;
  for (let li = 0; li < n; li++) {
    const l = lines[li];
    let inWord = false;
    for (let k = 0; k < l.length; k++) {
      const c = l.charCodeAt(k);
      const ws =
        c < 128
          ? WS_TAB[c] === 1
          : c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
      if (ws) inWord = false;
      else if (!inWord) {
        inWord = true;
        words++;
      }
    }
  }
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line === '' || c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpenOf(line);
      if (lang !== null) {
        const parts = [`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`];
        i++;
        while (i < n && !isFenceClose(lines[i])) {
          parts.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        parts.push('</code></pre>');
        blocks.push(parts.join(''), '\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inlineStr(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`, '\n');
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>', '\n');
        i++;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [];
        while (i < n) {
          const bb = bulletOf(lines[i]);
          if (bb !== null) {
            items.push([trimLine(bb)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const parts = ['<ul>', '\n'];
        for (const parts2 of items) parts.push('<li>', inlineStr(parts2.join('\n'), link), '</li>\n');
        parts.push('</ul>');
        blocks.push(parts.join(''), '\n');
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const inner = body.map(trimLine).filter((l) => l !== '');
      blocks.push(
        inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(inner.join('\n'), link)}</p>\n</blockquote>`,
        '\n',
      );
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        const startNum = Number(o.num);
        const items = [];
        while (i < n) {
          const oo = orderedOf(lines[i]);
          if (oo !== null) {
            items.push([trimLine(oo.text)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const parts = [startNum !== 1 ? `<ol start="${startNum}">` : '<ol>', '\n'];
        for (const parts2 of items) parts.push('<li>', inlineStr(parts2.join('\n'), link), '</li>\n');
        parts.push('</ol>');
        blocks.push(parts.join(''), '\n');
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`, '\n');
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The value at `path` in the scope chain: its first name from the nearest frame
 * holding it (the chain is the frames' prototypes), then own properties of the
 * value so far, or undefined.
 */
function lookup(fr, first, ...rest) {
  let s = fr;
  while (s !== null && !Object.hasOwn(s, first)) s = Object.getPrototypeOf(s);
  if (s === null) return undefined;
  let v = s[first];
  for (let k = 0; k < rest.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, rest[k])) return undefined;
    v = v[rest[k]];
  }
  return v;
}

/** Names whose direct read off a frame would not be the scope lookup (they live on the frame's prototype link). */
const DIRECT_DENY = new Set(['__proto__', 'constructor', 'prototype']);

/** A path as a JavaScript expression reading it off frame `fr`. Single names read
 * straight off the frame (its prototype chain is the scope chain); deeper paths
 * inline the own-property walk with a shared temp, which is safe because a
 * lookup expression is evaluated atomically and holds no live value across a
 * second lookup. */
function pathExpr(path, fr) {
  if (path.length === 1) {
    const name = path[0];
    if (DIRECT_DENY.has(name)) return `lookup(${fr},${JSON.stringify(name)})`;
    return `${fr}.${name}`;
  }
  if (DIRECT_DENY.has(path[0])) return `lookup(${fr},${path.map((p) => JSON.stringify(p)).join(',')})`;
  let e = `${fr}.${path[0]}`;
  for (let k = 1; k < path.length; k++) {
    const p = JSON.stringify(path[k]);
    e = `(($v=${e})==null||typeof $v!=="object"||!Object.hasOwn($v,${p})?undefined:$v[${p}])`;
  }
  return e;
}

/**
 * A template's node tree compiled to a render function (fr, out, ctx, depth):
 * fr is the scope frame (an object whose prototype is its parent frame, down to
 * a null-prototype root), out the string array, ctx the map of compiled
 * templates, depth the include depth. Loop frames and loop records are made once
 * per loop, not per item, and the loop record is mutated per item: rendering is
 * synchronous, so nothing can observe the reuse.
 */
function compileNodes(nodes, fr, uid) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') code += `out.push(${JSON.stringify(n.text)});`;
    else if (n.kind === 'var') code += `out.push(escapeHtml(textOf(${pathExpr(n.path, fr)})));`;
    else if (n.kind === 'raw') code += `out.push(textOf(${pathExpr(n.path, fr)}));`;
    else if (n.kind === 'if') {
      code += `if(truthy(${pathExpr(n.path, fr)})!==${n.not}){${compileNodes(n.then, fr, uid)}}`;
      if (n.else !== null) code += `else{${compileNodes(n.else, fr, uid)}}`;
    } else if (n.kind === 'for') {
      const id = uid.next++;
      const xs = `$x${id}`;
      const ix = `$i${id}`;
      const nf = `$f${id}`;
      const lp = `$l${id}`;
      code += `{const ${xs}=${pathExpr(n.path, fr)};if(Array.isArray(${xs})){const ${nf}=Object.create(${fr});const ${lp}={index:0,first:false,last:false,length:${xs}.length};for(let ${ix}=0;${ix}<${xs}.length;${ix}++){${nf}[${JSON.stringify(n.name)}]=${xs}[${ix}];${nf}.loop=${lp};${lp}.index=${ix}+1;${lp}.first=${ix}===0;${lp}.last=${ix}===${xs}.length-1;${compileNodes(n.body, nf, uid)}}}}`;
    } else if (n.kind === 'include') {
      code += `if(depth<${INCLUDE_DEPTH}){const $t=ctx.get(${JSON.stringify(n.name)});if($t!==undefined)$t(${fr},out,ctx,depth+1);}`;
    }
  }
  return code;
}

/** `src` parsed and compiled to its render function. */
export function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  const uid = { next: 0 };
  const body = compileNodes(nodes, 'fr', uid);
  return new Function(
    'escapeHtml',
    'textOf',
    'truthy',
    'lookup',
    `return function(fr,out,ctx,depth){let $v;${body}}`,
  )(escapeHtml, textOf, truthy, lookup);
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slugOf = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugify(text);
      slugCache.set(text, v);
    }
    return v;
  };
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (scheme.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(md.words / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugOf(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  // One scope frame for every render of this case: site, tags and recent are
  // fixed, the per-render names are cleared (to undefined, which reads exactly
  // like absent) and then set. Rendering is synchronous, so no child frame
  // created during a render can observe the next render's names.
  const fr = Object.create(null);
  fr.site = site;
  fr.tags = allTags;
  fr.recent = recent;
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    fr.page = undefined;
    fr.posts = undefined;
    fr.pager = undefined;
    fr.tag = undefined;
    Object.assign(fr, vars);
    const out = [];
    fn(fr, out, templates, 0);
    return out.join('');
  };
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
