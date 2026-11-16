// A dependency-free Markdown renderer whose parse(markdown) returns exactly
// the HTML marked 18.1.3 renders with its defaults (gfm on, breaks off).
// Written from scratch against the CommonMark 0.31.2 and GFM 0.29 specs,
// verified against marked's own outputs case by case.

// ---------------------------------------------------------------- utilities

const CC = {
  SPACE: 32, TAB: 9, LF: 10, CR: 13, BANG: 33, QUOTE: 34, HASH: 35, DOLLAR: 36,
  PERCENT: 37, AMP: 38, SQUOTE: 39, LPAREN: 40, RPAREN: 41, STAR: 42, PLUS: 43,
  COMMA: 44, MINUS: 45, DOT: 46, SLASH: 47, COLON: 58, SEMI: 59, LT: 60,
  EQ: 61, GT: 62, QUEST: 63, AT: 64, LBRACK: 91, BSLASH: 92, RBRACK: 93,
  CARET: 94, UNDER: 95, BTICK: 96, LBRACE: 123, PIPE: 124, RBRACE: 125, TILDE: 126,
};

function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13; }
function isSpaceOrTab(c) { return c === 32 || c === 9; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(c) {
  // ASCII punctuation, plus Unicode general categories P and S
  // (used for emphasis flanking; backslash escapes use isAsciiPunct)
  if (c >= 0 && c < 128) return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  if (!(c >= 128)) return false; // NaN, -1, or a surrogate half
  if (c >= 0xd800 && c <= 0xdfff) return false;
  return UNICODE_PUNCT_RE.test(String.fromCodePoint(c));
}
function isAsciiPunct(c) {
  return c >= 33 && c <= 47 || c >= 58 && c <= 64 || c >= 91 && c <= 96 || c >= 123 && c <= 126;
}
function isWhitespace(c) { return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13; }

// ---------------------------------------------------------------- escaping
//
// marked escapes text with the "no-encode" rule: & is left alone when it
// starts something entity-shaped (&word; or a numeric reference in range),
// and " ' < > are always escaped. Code content escapes & unconditionally.

const NO_ENCODE_RE = /&(?!(#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|\w+);)/g;

function escapeText(s) {
  // fast path: nothing to escape
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      // entity-shaped? &word; / &#digits; / &#xhex;
      let j = i + 1;
      if (s.charCodeAt(j) === 35) { // #
        j++;
        let hex = false;
        if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
        const ds = j;
        while (j < s.length && (hex ? isHex(s.charCodeAt(j)) : isDigit(s.charCodeAt(j)))) j++;
        const n = j - ds;
        if (n >= 1 && n <= (hex ? 6 : 7) && s.charCodeAt(j) === 59) continue; // leave alone
      } else {
        while (j < s.length && (isAlnum(s.charCodeAt(j)))) j++;
        if (j > i + 1 && s.charCodeAt(j) === 59) continue; // &word; leave alone
      }
      rep = '&amp;';
    } else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    if (rep !== null) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

function isHex(c) { return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }

function escapeCode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    if (rep !== null) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Attribute values use the same no-encode rule as text.
const escapeAttr = escapeText;

// Decode a numeric character reference starting at s[i] === '&'.
// Returns [decodedChar, nextIndex] or null when not a valid numeric ref.
function decodeNumericRef(s, i) {
  // s[i] === '&', s[i+1] === '#'
  let j = i + 2;
  let hex = false;
  if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
  const ds = j;
  while (j < s.length && (hex ? isHex(s.charCodeAt(j)) : isDigit(s.charCodeAt(j)))) j++;
  const n = j - ds;
  if (n < 1 || n > (hex ? 6 : 7) || s.charCodeAt(j) !== 59) return null;
  let cp = parseInt(s.slice(ds, j), hex ? 16 : 10);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return [String.fromCodePoint(cp), j + 1];
}

// ---------------------------------------------------------------- URLs
//
// marked's cleanUrl: encodeURI of the destination (which leaves existing
// %XX sequences and the URI-reserved characters alone, and percent-encodes
// spaces and non-ASCII as UTF-8). Returns null when encodeURI throws
// (a lone surrogate), in which case the link does not form.

function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

// ---------------------------------------------------------------- line cursor
//
// A cursor over one raw line, tracking column (with tab stops of 4) and a
// partially consumed tab (its remaining virtual spaces).

class Cur {
  constructor(s) { this.s = s; this.i = 0; this.col = 0; this.pt = 0; }
  save() { return [this.i, this.col, this.pt]; }
  restore(st) { this.i = st[0]; this.col = st[1]; this.pt = st[2]; }
  ch() {
    if (this.pt > 0) return 32;
    return this.i < this.s.length ? this.s.charCodeAt(this.i) : -1;
  }
  // advance n columns (consuming chars; a tab may be consumed partially)
  adv(n) {
    while (n > 0) {
      if (this.pt > 0) { const t = this.pt < n ? this.pt : n; this.pt -= t; this.col += t; n -= t; continue; }
      if (this.i >= this.s.length) return;
      const c = this.s.charCodeAt(this.i);
      if (c === 9) {
        const w = 4 - (this.col & 3);
        if (w > n) { this.pt = w - n; this.col += n; this.i++; n = 0; }
        else { this.i++; this.col += w; n -= w; }
      } else { this.i++; this.col++; n--; }
    }
  }
  // columns of whitespace from here
  indent() {
    let col = this.col + this.pt, i = this.i, n = this.pt;
    while (i < this.s.length) {
      const c = this.s.charCodeAt(i);
      if (c === 32) { n++; i++; col++; }
      else if (c === 9) { const w = 4 - (col & 3); n += w; col += w; i++; }
      else break;
    }
    return n;
  }
  blank() {
    for (let i = this.i; i < this.s.length; i++) {
      const c = this.s.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  // remaining text from here, partial tab expanded to spaces
  rest() {
    return this.pt > 0 ? ' '.repeat(this.pt) + this.s.slice(this.i) : this.s.slice(this.i);
  }
  // remaining text, with leading whitespace stripped (used for content)
  restTrimmed() {
    let r = this.rest();
    let k = 0;
    while (k < r.length && (r.charCodeAt(k) === 32 || r.charCodeAt(k) === 9)) k++;
    return r.slice(k);
  }
}

// ---------------------------------------------------------------- block tree

function node(t, parent) {
  const n = { t, children: [], startLine: -1, endLine: -1 };
  if (parent) { parent.children.push(n); n.parent = parent; }
  return n;
}

// HTML block types (CommonMark): 1 script/pre/style/textarea, 2 comment,
// 3 processing instruction, 4 declaration, 5 CDATA, 6 block tag, 7 open tag
// line (cannot interrupt a paragraph).
const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// Scan a complete open or close tag starting at s[i] === '<'.
// Returns the index just after the closing '>', or -1 if not a valid tag.
// Tag name: letter followed by letters, digits or hyphens.
function scanTagEnd(s, i) {
  let k = i + 1;
  let closing = false;
  if (s.charCodeAt(k) === 47) { closing = true; k++; }
  if (!isAlpha(s.charCodeAt(k))) return -1;
  while (k < s.length && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 45)) k++;
  if (closing) {
    while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (s.charCodeAt(k) !== 62) return -1;
    return k + 1;
  }
  while (true) {
    while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (s.charCodeAt(k) === 62) return k + 1;
    if (s.charCodeAt(k) === 47 && s.charCodeAt(k + 1) === 62) return k + 2;
    if (k >= s.length) return -1;
    const ac = s.charCodeAt(k);
    if (!(isAlpha(ac) || ac === 95 || isDigit(ac))) return -1;
    while (k < s.length) {
      const d = s.charCodeAt(k);
      if (isAlnum(d) || d === 95 || d === 58 || d === 46 || d === 45) k++;
      else break;
    }
    while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (s.charCodeAt(k) === 61) {
      k++;
      while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
      const q = s.charCodeAt(k);
      if (q === 34 || q === 39) {
        k++;
        while (k < s.length && s.charCodeAt(k) !== q) k++;
        if (k >= s.length) return -1;
        k++;
        // after a quoted value there must be whitespace, > or / (not a
        // letter glued onto the value)
        const after = s.charCodeAt(k);
        if (!(k >= s.length || after === 32 || after === 9 || after === 10 || after === 62 || after === 47)) return -1;
      } else {
        let vn = 0;
        while (k < s.length) {
          const d = s.charCodeAt(k);
          if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          k++; vn++;
        }
        if (vn === 0) return -1;
      }
    }
  }
}

// Try to match an HTML block start at s[i] === '<'. Returns the type (1-7)
// or 0. Types 1-6 need only the tag name followed by space/tab/EOL/>//;
// type 7 needs a complete tag extending to the end of the line.
function htmlBlockStart(s, i) {
  // s[i] === '<'
  if (s.charCodeAt(i + 1) === 33) { // !
    if (s.charCodeAt(i + 2) === 45 && s.charCodeAt(i + 3) === 45) return 2; // <!--
    if (s.charCodeAt(i + 2) === 91) { // <![CDATA[
      if (s.slice(i + 3, i + 10) === 'CDATA[') return 5;
      return 0;
    }
    // <!A... declaration: letter after !
    const c = s.charCodeAt(i + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 4;
    return 0;
  }
  if (s.charCodeAt(i + 1) === 63) return 3; // <?
  // open or close tag: parse the name (letter, then letters/digits/hyphens)
  let j = i + 1;
  const closing = s.charCodeAt(j) === 47;
  if (closing) j++; // </
  if (!isAlpha(s.charCodeAt(j))) return 0;
  let name = '';
  while (j < s.length && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 45)) { name += s[j]; j++; }
  const lower = name.toLowerCase();
  const c = j >= s.length ? -1 : s.charCodeAt(j);
  // the name must be followed by space, tab, EOL, > or /
  if (!(c === -1 || c === 32 || c === 9 || c === 62 || c === 47)) return 0;
  // type 1 is for OPEN tags only; a closing tag is type 6 or 7
  if (!closing && (lower === 'script' || lower === 'pre' || lower === 'style' || lower === 'textarea')) return 1;
  if (HTML_BLOCK_TAGS.has(lower)) return 6;
  // type 7: any other complete tag extending to end of line
  const end = scanTagEnd(s, i);
  if (end !== -1) {
    let k = end;
    while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
    if (k >= s.length) return 7;
  }
  return 0;
}

// Does the line (from cur) contain the end marker for an HTML block type?
function htmlBlockEnd(type, line) {
  if (type === 1) return /<\/(script|pre|style|textarea)[\s>]/i.test(line) || /<\/(script|pre|style|textarea)$/i.test(line);
  if (type === 2) return line.indexOf('-->') !== -1;
  if (type === 3) return line.indexOf('?>') !== -1;
  if (type === 4) return line.indexOf('>') !== -1;
  if (type === 5) return line.indexOf(']]>') !== -1;
  return false;
}

// Does the (single-line) block's last line end with its end marker, so
// that no content follows the marker? (trailing whitespace ignored)
function htmlEndMarkerAtEOL(type, line) {
  const t = line.replace(/[ \t]+$/, '');
  if (type === 2) return t.endsWith('-->');
  if (type === 3) return t.endsWith('?>');
  if (type === 4) return t.endsWith('>');
  if (type === 5) return t.endsWith(']]>');
  return false;
}

// Thematic break: up to 3 spaces, then 3+ of -, _, * (same char), spaces/tabs only.
function isThematicBreak(s, i) {
  let j = i, c = s.charCodeAt(j);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  const mark = c;
  let n = 0;
  while (j < s.length) {
    const d = s.charCodeAt(j);
    if (d === mark) n++;
    else if (d === 32 || d === 9) { /* skip */ }
    else return false;
    j++;
  }
  return n >= 3;
}

// ATX heading: up to 3 spaces, 1-6 #, then space/tab/EOL or closing sequence.
function atxHeading(s, i) {
  let j = i, n = 0;
  while (s.charCodeAt(j) === 35 && n < 7) { n++; j++; }
  if (n === 0 || n > 6) return null;
  const c = j >= s.length ? -1 : s.charCodeAt(j);
  if (c !== -1 && c !== 32 && c !== 9) return null;
  // skip spaces/tabs, then strip a closing sequence of #s preceded by space
  let k = j;
  while (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9) k++;
  let end = s.length;
  while (end > k && s.charCodeAt(end - 1) === 32) end--;
  let e2 = end;
  while (e2 > k && s.charCodeAt(e2 - 1) === 35) e2--;
  if (e2 < end && (e2 === k || s.charCodeAt(e2 - 1) === 32 || s.charCodeAt(e2 - 1) === 9)) end = e2;
  while (end > k && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  return { level: n, text: s.slice(k, end) };
}

// Is this line a setext '=' underline (up to 3 spaces, 1+ '=', spaces only)?
function isSetextEqLine(text) {
  let j = 0;
  while (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9) j++;
  if (j > 3 || text.charCodeAt(j) !== 61) return false;
  while (text.charCodeAt(j) === 61) j++;
  while (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9) j++;
  return j >= text.length;
}

// Setext underline: up to 3 spaces, 1+ of the same = or -, then only
// spaces/tabs. No spaces inside the run.
function setextLevel(s, i) {
  let j = i;
  const c = s.charCodeAt(j);
  if (c !== 61 && c !== 45) return 0;
  let n = 0;
  while (j < s.length && s.charCodeAt(j) === c) { n++; j++; }
  if (n === 0) return 0;
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  if (j < s.length) return 0;
  return c === 61 ? 1 : 2;
}

// Fenced code start: up to 3 spaces, 3+ ` or ~.
function fenceStart(s, i) {
  let j = i;
  const c = s.charCodeAt(j);
  if (c !== 96 && c !== 126) return null;
  let n = 0;
  while (s.charCodeAt(j) === c) { n++; j++; }
  if (n < 3) return null;
  if (c === 96 && s.indexOf('`', j) !== -1) return null; // info must not contain `
  return { ch: c, len: n, info: s.slice(j).trim() };
}

// Closing fence: up to 3 spaces, fenceChar run >= len, then spaces/tabs only.
function isClosingFence(s, i, ch, len) {
  let j = i, n = 0;
  while (s.charCodeAt(j) === ch) { n++; j++; }
  if (n < len) return false;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
    j++;
  }
  return true;
}

// List item start: up to 3 spaces, then bullet (-, +, *) + space/tab/EOL,
// or ordered digits (1-9 digits) + . or ) + space/tab/EOL.
// Returns {bullet, ordered, start, markerLen, contentIndent} or null.
// contentIndent: columns from line start to the content (marker + spaces).
function listItemStart(cur) {
  const s = cur.s;
  let i = cur.i;
  // up to 3 spaces of indent (tabs count)
  const save = cur.save();
  const ind = cur.indent();
  if (ind > 3) return null;
  cur.adv(ind);
  const c = cur.ch();
  let bullet = null, ordered = false, start = 0, markerLen = 0, delim = '.';
  if (c === 45 || c === 43 || c === 42) {
    bullet = String.fromCharCode(c); markerLen = 1;
  } else if (isDigit(c)) {
    let j = cur.i, n = 0, v = 0;
    while (j < s.length && isDigit(s.charCodeAt(j)) && n < 9) { v = v * 10 + (s.charCodeAt(j) - 48); n++; j++; }
    if (n === 0 || n > 9) { cur.restore(save); return null; }
    const d = s.charCodeAt(j);
    if (d !== 46 && d !== 41) { cur.restore(save); return null; }
    ordered = true; start = v; markerLen = n + 1; delim = d === 41 ? ')' : '.';
  } else { cur.restore(save); return null; }
  // after the marker: need 1+ spaces/tabs, or end of line
  const after = cur.i + markerLen;
  if (after >= s.length) {
    // empty item: content indent = marker + 1
    cur.restore(save);
    return { bullet, ordered, start, markerLen, delim, empty: true, contentIndent: ind + markerLen + 1 };
  }
  const d = s.charCodeAt(after);
  if (d !== 32 && d !== 9) { cur.restore(save); return null; }
  // count spaces after marker (tabs count as columns)
  let col = cur.col + markerLen, k = after, spaces = 0;
  while (k < s.length) {
    const e = s.charCodeAt(k);
    if (e === 32) { spaces++; k++; col++; }
    else if (e === 9) { const w = 4 - (col & 3); spaces += w; k++; col += w; }
    else break;
  }
  if (spaces === 0) { cur.restore(save); return null; }
  cur.restore(save);
  if (k >= s.length || spaces >= 5) {
    // 5+ spaces after marker: content indent is marker + 1
    return { bullet, ordered, start, markerLen, delim, empty: k >= s.length, contentIndent: ind + markerLen + 1, spacesAfter: 1 };
  }
  return { bullet, ordered, start, markerLen, delim, empty: false, contentIndent: ind + markerLen + spaces, spacesAfter: spaces };
}

// Table delimiter row: up to 3 spaces, then cells of :?-+:? separated by |.
function tableDelimiter(s, i) {
  let j = i;
  // up to 3 spaces; a 4th space or a tab means not a delimiter row
  let sp = 0;
  while (s.charCodeAt(j) === 32 && sp < 3) { j++; sp++; }
  if (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9) return null;
  const cells = [];
  let cur = '';
  let hasPipe = false;
  for (let k = j; k <= s.length; k++) {
    const c = k < s.length ? s.charCodeAt(k) : -1;
    if (c === 124 || c === -1) { // |
      cells.push(cur); cur = '';
      if (c === 124) hasPipe = true;
      continue;
    }
    cur += s[k];
  }
  // strip empty first/last cell (leading/trailing pipe)
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    aligns.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : null);
  }
  return aligns;
}

// Split a table row line into cells (unescaped pipes split; an escaped
// pipe \| becomes a literal | in the cell, so the inline parser sees |
// rather than \|).
function splitTableRow(s) {
  const cells = [];
  let cur = '';
  let i = 0;
  // leading pipe (after optional leading spaces/tabs)
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (s.charCodeAt(i) === 124) i++;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) { cur += '|'; i++; continue; }
    if (c === 124) { cells.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur);
  // trailing pipe: last cell is empty because of it
  if (cells.length > 1 && cells[cells.length - 1].trim() === '' && s.trimEnd().endsWith('|')) cells.pop();
  return cells.map(x => x.trim());
}

// ---------------------------------------------------------------- link references

function normalizeLabel(s) {
  // case-fold (Unicode lowercase + full folding for sharp-s, ligatures,
  // micro sign) and collapse whitespace runs to one space
  return s.toLowerCase()
    .replace(/\u00df/g, 'ss') // ß (and ẞ, which lowercases to ß)
    .replace(/\u00b5/g, '\u03bc') // µ micro sign -> μ
    .replace(/\ufb00/g, 'ff').replace(/\ufb01/g, 'fi').replace(/\ufb02/g, 'fl')
    .replace(/\ufb03/g, 'ffi').replace(/\ufb04/g, 'ffl')
    .replace(/\ufb05/g, 'st').replace(/\ufb06/g, 'st')
    .replace(/\s+/g, ' ').trim();
}

// Parse a link label starting at s[i] === '['. Returns {label, next} or null.
function parseLinkLabel(s, i) {
  // label: [ ... ] with no unescaped [ or ], up to 999 chars.
  // The label is kept RAW (backslash escapes are not resolved) because
  // labels match on their raw text. An empty label is allowed (it marks
  // a collapsed reference); a label of only whitespace is not a label.
  let j = i + 1, label = '';
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) {
      label += s[j] + s[j + 1]; j += 2; continue; // backslash escape, kept raw
    }
    if (c === 91 || c === 93) break;
    label += s[j]; j++;
  }
  if (j >= s.length || s.charCodeAt(j) !== 93) return null;
  if (label.length > 999) return null;
  if (label.length > 0 && label.trim() === '') return null;
  return { label, next: j + 1 };
}

// Parse a link destination starting at s[i] (after optional whitespace/newlines
// already skipped by caller). Returns {dest, next} or null.
// In <...>: no <, >, newline; backslash escapes allowed.
// Bare: no spaces/control; balanced parens allowed.
function parseLinkDest(s, i) {
  if (s.charCodeAt(i) === 60) { // <
    let j = i + 1, dest = '';
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 10 || c === 60) return null;
      if (c === 62) return { dest, next: j + 1 };
      if (c === 92 && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) { dest += s[j + 1]; j += 2; continue; }
      dest += s[j]; j++;
    }
    return null;
  }
  let j = i, dest = '', depth = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c < 32) break;
    if (c === 92 && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) { dest += s[j + 1]; j += 2; continue; }
    if (c === 40) depth++;
    else if (c === 41) { if (depth === 0) break; depth--; }
    dest += s[j]; j++;
  }
  if (dest.length === 0 && j === i) {
    // empty destination (e.g. [link]()) is valid
    return { dest: '', next: j };
  }
  if (dest.length === 0) return null;
  return { dest, next: j };
}

// Parse a link title starting at s[i] ('"' or '\'' or '('). Returns {title, next} or null.
function parseLinkTitle(s, i) {
  const q = s.charCodeAt(i);
  let close, j;
  if (q === 34 || q === 39) { close = q; j = i + 1; }
  else if (q === 40) { close = 41; j = i + 1; }
  else return null;
  let title = '';
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === close) return { title, next: j + 1 };
    if (close === 41 && c === 40) return null; // no unescaped ( in paren title
    if (c === 10) {
      // a blank line ends the title
      let k = j + 1;
      while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
      if (k >= s.length || s.charCodeAt(k) === 10) return null;
    }
    if (c === 92 && j + 1 < s.length && isAsciiPunct(s.charCodeAt(j + 1))) { title += s[j + 1]; j += 2; continue; }
    title += s[j]; j++;
  }
  return null;
}

// Skip spaces, tabs and newlines. Returns new index.
// Validate a link label's raw text against marked's label regex `re`
// (nested brackets, escapes, code spans with no backtick in the content,
// backticks just before the closing ']', or any other single character).
// The `` ``+(?=\]) `` alternative becomes `` `+$ `` here because the label
// text is tested without its closing ']'. Only needed when the label
// contains a backtick: without one, the bracket stack already matches
// marked. Returns true when the whole label text is matchable.
const _LABEL_BRACKETS = "\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]";
const LABEL_VALID_RE = new RegExp(
  "^(?:\\[(?:" + _LABEL_BRACKETS + "|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|`+$|[^\\[\\]\\\\`])*$"
);
function labelTextValid(s) { return LABEL_VALID_RE.test(s); }

// Code-span ranges [start, end) inside a link label, pairing backtick
// runs greedily the way marked's label regex does (an opening run pairs
// with the next run; the content between them has no backticks). Used to
// tell whether a backtick is claimed by a code span in the label.
function labelCodeSpans(s) {
  const spans = [];
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) !== 96) { i++; continue; }
    let j = i;
    while (j < s.length && s.charCodeAt(j) === 96) j++;
    // find the next backtick run
    let k = j;
    while (k < s.length && s.charCodeAt(k) !== 96) k++;
    if (k >= s.length) break; // lone run: no code span
    let m = k;
    while (m < s.length && s.charCodeAt(m) === 96) m++;
    spans.push([i, m]);
    i = m;
  }
  return spans;
}

function skipWSNL(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Try to parse one link reference definition at s[i] (i at '[').
// Returns {dest, title, next} (next = index after the definition) or null.
function parseLinkDef(s, i, refs) {
  const lab = parseLinkLabel(s, i);
  if (!lab || lab.label.length === 0) return null; // a definition needs a label
  let j = lab.next;
  if (s.charCodeAt(j) !== 58) return null; // :
  j++;
  // skip spaces/tabs, then at most one newline + spaces/tabs (the
  // destination may be on the next line, but not after a blank line)
  while (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9) j++;
  if (s.charCodeAt(j) === 10) {
    j++;
    while (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9) j++;
    if (s.charCodeAt(j) === 10 || j >= s.length) return null;
  }
  const dest = parseLinkDest(s, j);
  // a definition needs a destination; an empty angle destination (<>) is
  // valid, but an empty bare destination is not
  if (!dest || (dest.dest === '' && s.charCodeAt(j) !== 60)) return null;
  j = dest.next;
  // after the destination, spaces/tabs on the same line
  let k = j;
  while (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9) k++;
  const hadSpace = k > j;
  const atEOL = k >= s.length || s.charCodeAt(k) === 10;
  if (!atEOL && !hadSpace) return null; // junk right after the destination
  // try a title: on this line (if preceded by a space) or the next line
  let tk = k;
  if (atEOL && s.charCodeAt(tk) === 10) {
    tk++;
    while (s.charCodeAt(tk) === 32 || s.charCodeAt(tk) === 9) tk++;
  }
  const q = s.charCodeAt(tk);
  if ((atEOL || hadSpace) && (q === 34 || q === 39 || q === 40)) {
    const t = parseLinkTitle(s, tk);
    if (t) {
      let m = t.next;
      while (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9) m++;
      if (m >= s.length || s.charCodeAt(m) === 10) {
        // valid title: consume through the newline after it
        const key = normalizeLabel(lab.label);
        if (!refs.has(key)) refs.set(key, { dest: dest.dest, title: t.title });
        return { next: m < s.length ? m + 1 : m };
      }
      // title followed by junk: a title on the same line as the
      // destination invalidates the whole definition; a title on the
      // next line is just dropped (destination-only definition)
      if (!atEOL) return null;
    } else if (!atEOL) {
      // an unterminated title on the same line invalidates the definition
      return null;
    }
  } else if (!atEOL) {
    // junk on the same line after the destination (not a title)
    return null;
  }
  // destination only: consume through the newline after the destination
  // (a rejected title on the next line is not consumed)
  return destOnly();
  function destOnly() {
    const key = normalizeLabel(lab.label);
    if (!refs.has(key)) refs.set(key, { dest: dest.dest, title: null });
    if (atEOL) return { next: k < s.length ? k + 1 : k };
    return { next: k };
  }
}

// Parse leading link reference definitions out of a paragraph's text.
// Returns the remaining text ('' when the paragraph is only definitions).
function stripLinkDefs(text, refs) {
  let i = 0;
  while (true) {
    // skip blank lines between definitions? (a blank line ends the paragraph,
    // so definitions are only at the very start, possibly across lines)
    let j = i;
    while (j < text.length && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
    if (text.charCodeAt(j) !== 91) break; // not '['
    const d = parseLinkDef(text, j, refs);
    if (!d) break;
    i = d.next;
  }
  return text.slice(i);
}

// ---------------------------------------------------------------- block parsing

function parseBlocks(src) {
  const normalized = src.replace(/\r\n?/g, '\n');
  const endsNL = normalized.length > 0 && normalized.charCodeAt(normalized.length - 1) === 10;
  let lines = normalized === '' ? [] : normalized.split('\n');
  if (endsNL) lines.pop();
  const totalLines = lines.length;
  const doc = { t: 'doc', children: [] };
  const refs = new Map();
  const blankLines = new Set();
  const open = [doc];

  // mark a block (and its ancestors) as spanning line li
  function touchEnd(blk, li) {
    let b = blk;
    while (b) { if (b.endLine < li) b.endLine = li; b = b.parent; }
  }

  function addChild(parent, blk, lineIdx) {
    blk.parent = parent;
    blk.startLine = lineIdx;
    blk.endLine = lineIdx;
    parent.children.push(blk);
    if (parent.t === 'item') parent.empty = false; // the item has content now
    touchEnd(parent, lineIdx);
    return blk;
  }

  function closeBlock(blk) {
    if (blk.t === 'para') {
      const text = blk.lines.join('\n');
      const rest = stripLinkDefs(text, refs);
      if (rest.trim() === '') {
        // paragraph was only definitions: remove it, and pull its
        // parent's range back to the last remaining child
        const p = blk.parent.children;
        p.splice(p.indexOf(blk), 1);
        if (p.length > 0) blk.parent.endLine = p[p.length - 1].endLine;
        else blk.parent.endLine = blk.parent.startLine;
      } else {
        blk.text = rest;
      }
    } else if (blk.t === 'list') {
      // tight or loose? a blank line strictly between two children of
      // one item, or between two items (using each block's actual span,
      // so a trailing blank line inside an item does not count)
      let loose = false;
      const items = blk.children;
      for (let a = 0; a < items.length; a++) {
        const it = items[a];
        const ch = it.children;
        for (let b = 0; b + 1 < ch.length; b++) {
          if (blankBetween(ch[b].endLine, ch[b + 1].startLine)) { loose = true; break; }
        }
        if (loose) break;
        if (a + 1 < items.length && blankBetween(it.endLine, items[a + 1].startLine)) { loose = true; break; }
      }
      blk.tight = !loose;
    } else if (blk.t === 'code') {
      // strip trailing blank lines
      while (blk.lines.length > 0 && blk.lines[blk.lines.length - 1] === '') blk.lines.pop();
    }
  }

  function blankBetween(endLine, startLine) {
    for (let b = endLine + 1; b < startLine; b++) if (blankLines.has(b)) return true;
    return false;
  }

  function closeAbove(idx) {
    // close (and finalize) open blocks from the end down to index idx
    while (open.length > idx) {
      const blk = open.pop();
      closeBlock(blk);
    }
  }

  for (let li = 0; li < totalLines; li++) {
    const rawLine = lines[li];
    const cur = new Cur(rawLine);
    // indent (spaces before '>') of the innermost quote matched on this
    // line, and the total columns consumed by quote prefixes / the width
    // of the innermost quote's prefix (for tilde fence tabs: each outer
    // quote level re-bases the tab column)
    let lastQuoteInd = 0;
    let quoteWidthTotal = 0, lastQuoteWidth = 0;
    // ---- phase 1: match open containers
    let idx = 1;
    let lastMatched = doc;
    while (idx < open.length) {
      const blk = open[idx];
      if (blk.t === 'quote') {
        const save = cur.save();
        const ind = cur.indent();
        const w0 = cur.col;
        if (ind <= 3) cur.adv(ind);
        if (cur.ch() === 62) { // >
          lastQuoteInd = ind;
          cur.adv(1);
          if (cur.ch() === 32 || cur.ch() === 9) cur.adv(1);
          lastQuoteWidth = cur.col - w0;
          quoteWidthTotal += lastQuoteWidth;
          touchEnd(blk, li); // a > line belongs to the quote (and its ancestors)
          lastMatched = blk; idx++; continue;
        }
        cur.restore(save);
        break;
      } else if (blk.t === 'item') {
        if (cur.blank()) {
          if (blk.empty) blk.sawBlank = true;
          lastMatched = blk; idx++; continue;
        }
        // an empty item takes no content after a blank line
        if (blk.empty && blk.sawBlank) break;
        if (cur.indent() >= blk.contentIndent) {
          cur.adv(blk.contentIndent);
          lastMatched = blk; idx++; continue;
        }
        break;
      } else if (blk.t === 'list') {
        lastMatched = blk; idx++; continue;
      } else {
        break; // leaf block: phase 1 ends
      }
    }
    const leaf = open[open.length - 1];
    // phase 1 stopped at a container (quote/item) that failed to match.
    // A non-blank line that does not start an interrupting block is a lazy
    // continuation of an open paragraph: keep the containers open and let
    // the leaf handler add the line (a lazy line never starts a setext
    // heading or a table). Otherwise close the failed container(s).
    let lazyLine = false;
    if (idx < open.length && (open[idx].t === 'quote' || open[idx].t === 'item')) {
      const tip = open[open.length - 1];
      if (tip.t === 'para' && !cur.blank()) {
        // a list item marker never lazily continues a paragraph inside a
        // list item (even an empty one starts a new item there)
        const isItemMarker = open[idx].t === 'item' && listItemStart(cur) !== null;
        if (!isItemMarker && !startsInterrupt(cur, true, tip.parent && tip.parent.t === 'item')) {
          lazyLine = true;
        } else {
          closeAbove(idx);
        }
      } else if (tip.t === 'fence' && open[idx].t === 'item' && !cur.blank()) {
        // A fenced code block inside a list item lazily continues across a
        // line that lacks the item's content indent ONLY once it already
        // has content: an empty fence closes instead (the under-indented
        // line is not part of the item, so the fence never started).
        // A list item marker never lazily continues the fence either: it
        // starts a new item, closing this one (and the fence with it).
        if (tip.lines.length > 0 && listItemStart(cur) === null) lazyLine = true;
        else closeAbove(idx);
      } else {
        closeAbove(idx);
      }
    }
    const leafIsOpen = open.length > idx; // phase 1 stopped at a leaf
    const container = lastMatched;

    // record blankness (after container matching) for list tightness
    if (cur.blank()) blankLines.add(li);

    // ---- handle an open leaf
    let consumed = false;
    if (leafIsOpen) {
      if (leaf.t === 'fence') {
        // closing fence? up to 3 spaces, fence run, spaces only
        const save = cur.save();
        const ind = cur.indent();
        if (ind <= 3) {
          cur.adv(ind);
          if (isClosingFence(cur.s, cur.i, leaf.fenceCh, leaf.fenceLen)) {
            closeAbove(open.length - 1); // close the fence
            consumed = true;
          }
        }
        if (!consumed) {
          cur.restore(save);
          let line;
          if (leaf.fenceCh === 126) { // '~' (tilde fence)
            // Tilde fences: marked does not strip the opening fence's
            // indent from content lines. A leading tab inside a container
            // is expanded from the content-start column: inside a
            // blockquote that is the innermost quote's indent + 2, plus
            // the list-item indents inside that quote (marked expands
            // the whitespace after '>' from the prefix length, then the
            // inner items strip their indent from the expanded result).
            // With no quote it is the list-item indents.
            line = cur.rest();
            if (leaf.parent !== doc && line.indexOf('\t') !== -1) {
              const fb = fenceTabBase(leaf);
              const col = fb.quotes > 0 ? lastQuoteInd + 2 + fb.itemColsInside : fb.itemCols;
              line = expandLeadingTabs(line, col);
            }
          } else {
            // Backtick fences: content lines lose up to the opening
            // fence's indent. At the top level, a tab that straddles
            // the strip boundary is removed entirely (no partial tab
            // survives); inside a container the partial tab is kept
            // as spaces.
            const ci = cur.indent();
            if (ci > 0) cur.adv(Math.min(ci, leaf.fenceIndent || 0));
            if (cur.pt > 0 && leaf.parent === doc) cur.pt = 0;
            line = cur.rest();
            // inside a container, leading tabs in fence content expand to
            // spaces (at top level they are kept as tabs); the tab column
            // is the cursor column, except that list-item indents above
            // the fence's immediate parent are container prefixes (not
            // content columns), and each extra quote level adds one column
            if (leaf.parent !== doc && line.indexOf('\t') !== -1) {
              const fb = fenceTabBase(leaf);
              const aboveItem = leaf.parent.t === 'item' ? 0 : fb.itemCols;
              const col = cur.col - aboveItem - Math.max(0, fb.quotes - 1);
              line = expandLeadingTabs(line, col);
            }
          }
          leaf.lines.push(line);
          touchEnd(leaf, li);
          consumed = true;
        }
      } else if (leaf.t === 'code') {
        if (cur.blank()) {
          // a blank line inside indented code loses 4 columns too
          cur.adv(4);
          leaf.lines.push(cur.rest());
          touchEnd(leaf, li);
          consumed = true;
        } else if (cur.indent() >= 4) {
          cur.adv(4);
          leaf.lines.push(cur.rest());
          touchEnd(leaf, li);
          consumed = true;
        } else {
          closeAbove(open.length - 1); // close code block; fall through
        }
      } else if (leaf.t === 'html') {
        // types 1-5 continue through blank lines (they end only at their
        // end marker); types 6-7 end at a blank line
        if (cur.blank() && leaf.htmlType >= 6) {
          closeAbove(open.length - 1);
        } else {
          leaf.lines.push(cur.rest());
          touchEnd(leaf, li);
          if (leaf.htmlType === 1) {
            if (htmlBlockEnd(1, cur.rest())) { leaf.endedAtMarker = true; closeAbove(open.length - 1); }
          } else if (leaf.htmlType >= 2 && leaf.htmlType <= 5) {
            if (htmlBlockEnd(leaf.htmlType, cur.rest())) { leaf.endedAtMarker = true; closeAbove(open.length - 1); }
          }
          consumed = true;
        }
      } else if (leaf.t === 'table') {
        if (cur.blank()) {
          // A whitespace-only line ends the table, EXCEPT a line
          // containing a tab: marked treats a tab-only line as an
          // (empty) table row.
          if (cur.rest().indexOf('\t') !== -1) {
            leaf.rows.push(splitTableRow(cur.rest()));
            touchEnd(leaf, li);
            consumed = true;
          } else {
            closeAbove(open.length - 1);
          }
        } else if (startsInterrupt(cur, false) || cur.indent() >= 4) {
          // a line that starts a block (or indented code) ends the table
          closeAbove(open.length - 1);
        } else {
          const rowText = cur.rest();
          leaf.rows.push(splitTableRow(rowText));
          touchEnd(leaf, li);
          consumed = true;
        }
      } else if (leaf.t === 'para') {
        if (cur.blank()) {
          // a whitespace-only line is added to the paragraph only when it
          // is the document's last line (a trailing space line is kept);
          // otherwise it just closes the paragraph
          if (li === totalLines - 1 && cur.rest() !== '') {
            leaf.lines.push(cur.rest());
            touchEnd(leaf, li);
          }
          closeAbove(open.length - 1);
        } else {
          let lineText = cur.rest();
          // Inside a container (blockquote / list item) a leading tab
          // in a paragraph line expands to spaces. The column is the
          // cursor column, except inside a list item it resets to the
          // enclosing items' content indent (a blockquote prefix inside
          // a list item does not add to it); at the top level a leading
          // tab stays literal.
          if (leaf.parent !== doc && lineText.charCodeAt(0) !== -1) {
            let k = 0;
            while (k < lineText.length && (lineText.charCodeAt(k) === 32 || lineText.charCodeAt(k) === 9)) k++;
            if (k > 0 && lineText.slice(0, k).indexOf('\t') !== -1) {
              let col = cur.col;
              // Inside a blockquote the tab column is relative to the
              // list items enclosing that quote (their indents were
              // stripped before the quote was seen); without a quote
              // the cursor column already is the content column.
              let seenQ = false, outCols = 0;
              for (let b = leaf.parent; b && b.t !== 'doc'; b = b.parent) {
                if (b.t === 'quote') seenQ = true;
                else if (b.t === 'item' && seenQ) outCols += b.contentIndent;
              }
              if (seenQ) col -= outCols;
              lineText = expandLeadingTabs(lineText, col);
            }
          }
          // a lazy continuation line drops 4 columns of indent when it has
          // 4 or more, and never starts a setext heading or a table
          if (lazyLine) {
            if (cur.indent() >= 4) { cur.adv(4); lineText = cur.rest(); }
            // a lazy setext '=' line after another lazy line is indented
            // by exactly 4 spaces, so it is not read as a heading
            if (leaf.lastLazy && isSetextEqLine(lineText)) {
              lineText = '    ' + lineText.replace(/^[ \t]+/, '');
            }
            leaf.lines.push(lineText);
            touchEnd(leaf, li);
            leaf.lastLazy = true;
            consumed = true;
          } else {
          // setext underline?
          const save = cur.save();
          const ind = cur.indent();
          let sl = 0;
          if (ind <= 3) { cur.adv(ind); sl = setextLevel(cur.s, cur.i); }
          cur.restore(save);
          if (sl) {
            // convert paragraph to setext heading (unless it was only
            // link reference definitions: then there is no paragraph)
            const text = leaf.lines.join('\n');
            const rest = stripLinkDefs(text, refs).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            if (rest.trim() === '') {
              closeAbove(open.length - 1); // drop the defs-only paragraph; fall through
            } else {
              const parent = leaf.parent;
              const pos = parent.children.indexOf(leaf);
              parent.children.splice(pos, 1);
              const h = { t: 'heading', level: sl, text: rest, children: [], startLine: leaf.startLine, endLine: li, parent };
              parent.children.splice(pos, 0, h);
              open.pop();
              consumed = true;
            }
          } else {
            // table delimiter? (paragraph has exactly 1 line, and the
            // delimiter's cell count must match the header's)
            const aligns = leaf.lines.length === 1 ? tableDelimiter(lineText, 0) : null;
            const rest = aligns ? stripLinkDefs(leaf.lines.join('\n'), refs) : null;
            const headerCells = aligns ? splitTableRow(rest) : null;
            if (aligns && headerCells && headerCells.length === aligns.length) {
              const parent = leaf.parent;
              const pos = parent.children.indexOf(leaf);
              parent.children.splice(pos, 1);
              const tb = {
                t: 'table', aligns, header: headerCells, rows: [],
                children: [], startLine: leaf.startLine, endLine: li, parent,
              };
              parent.children.splice(pos, 0, tb);
              open.pop();
              open.push(tb);
              consumed = true;
            } else {
              // does a new block interrupt the paragraph?
              if (startsInterrupt(cur, true, leaf.parent && leaf.parent.t === 'item')) {
                closeAbove(open.length - 1); // fall through to new blocks
              } else {
                leaf.lines.push(lineText);
                touchEnd(leaf, li);
                leaf.lastLazy = false;
                consumed = true;
              }
            }
          }
          } // end of non-lazy branch
        }
      }
    }
    // a block still open at this line spans the line
    if (consumed) continue;

    // ---- phase 2: start new blocks (possibly nested)
    if (cur.blank()) continue;
    let cont = container;
    while (true) {
      // a blank line starts no block (a blockquote just opened above may
      // have consumed the line's only content)
      if (cur.blank()) break;
      const ind = cur.indent();
      // blockquote? '>' after up to 3 spaces
      if (ind <= 3) {
        const save = cur.save();
        cur.adv(ind);
        if (cur.ch() === 62) {
          cur.adv(1);
          if (cur.ch() === 32 || cur.ch() === 9) cur.adv(1);
          if (cont.t === 'list') { closeAbove(open.indexOf(cont)); cont = cont.parent; }
          const q = addChild(cont, { t: 'quote', children: [] }, li);
          open.push(q);
          cont = q;
          continue;
        }
        cur.restore(save);
      }
      // thematic break (takes precedence over a list item)
      if (ind <= 3) {
        const save = cur.save();
        cur.adv(ind);
        if (isThematicBreak(cur.s, cur.i)) {
          if (cont.t === 'list') { closeAbove(open.indexOf(cont)); cont = cont.parent; }
          addChild(cont, { t: 'hr', children: [] }, li);
          break;
        }
        cur.restore(save);
      }
      // list item?
      const itemStart = listItemStart(cur);
      if (itemStart) {
        let list = null;
        if (cont.t === 'list') {
          // reuse only when the marker matches this list
          if (cont.bullet === itemStart.bullet && cont.ordered === itemStart.ordered &&
              (!itemStart.ordered || cont.delim === itemStart.delim)) {
            list = cont;
          } else {
            closeAbove(open.indexOf(cont)); cont = cont.parent;
          }
        }
        if (!list) {
          const lastChild = cont.children[cont.children.length - 1];
          if (lastChild && lastChild.t === 'list' && open.includes(lastChild) &&
              lastChild.bullet === itemStart.bullet && lastChild.ordered === itemStart.ordered &&
              (!itemStart.ordered || lastChild.delim === itemStart.delim)) {
            list = lastChild;
          }
        }
        if (!list) {
          list = addChild(cont, {
            t: 'list', bullet: itemStart.bullet, ordered: itemStart.ordered,
            start: itemStart.start, delim: itemStart.delim, tight: true, children: [],
          }, li);
          open.push(list);
        }
        const item = addChild(list, {
          t: 'item', children: [], contentIndent: itemStart.contentIndent,
          empty: itemStart.empty, sawBlank: false,
        }, li);
        open.push(item);
        cont = item;
        // consume the marker + spaces (cursor is at the line start again:
        // listItemStart always restores it)
        cur.adv(ind + itemStart.markerLen);
        if (!itemStart.empty) cur.adv(itemStart.spacesAfter || 1);
        if (cur.blank()) {
          // empty item line: nothing more
          break;
        }
        continue;
      }
      // leaf starts (need up to 3 spaces of indent first)
      // a leaf cannot be a direct child of a list: close the list first
      if (cont.t === 'list') { closeAbove(open.indexOf(cont)); cont = cont.parent; }
      const paraSave = cur.save();
      if (ind <= 3) cur.adv(ind);
      const s = cur.s, i = cur.i;
      // ATX heading
      const atx = atxHeading(s, i);
      if (atx) {
        addChild(cont, { t: 'heading', level: atx.level, text: atx.text, children: [] }, li);
        break;
      }
      // fenced code
      const fs = fenceStart(s, i);
      if (fs) {
        const f = addChild(cont, {
          t: 'fence', fenceCh: fs.ch, fenceLen: fs.len, info: fs.info, fenceIndent: ind, lines: [], children: [],
        }, li);
        open.push(f);
        break;
      }
      // HTML block (the raw line keeps its leading spaces, up to 3)
      if (s.charCodeAt(i) === 60) {
        const hb = htmlBlockStart(s, i);
        if (hb) {
          cur.restore(paraSave);
          const line = cur.rest();
          const h = addChild(cont, { t: 'html', htmlType: hb, lines: [line], endedAtMarker: false, children: [] }, li);
          // type 1-5 may end on the same line
          if (hb >= 1 && hb <= 5 && htmlBlockEnd(hb, line)) {
            h.endedAtMarker = true;
            // closed immediately
          } else {
            open.push(h);
          }
          break;
        }
      }
      // indented code (only when not interrupting a paragraph; we are here
      // only when no paragraph is open)
      if (ind >= 4) {
        cur.adv(4);
        const c = addChild(cont, { t: 'code', lines: [cur.rest()], children: [] }, li);
        open.push(c);
        break;
      }
      // paragraph (keeps its leading spaces, up to 3)
      cur.restore(paraSave);
      let firstLine = cur.rest();
      // Inside a container a leading tab in the first paragraph line
      // expands to spaces (as in the continuation handler below); the
      // column resets to the enclosing items' content indent inside a
      // list item, else it is the cursor column; at the top level the
      // tab stays literal.
      if (cont !== doc) {
        let k = 0;
        while (k < firstLine.length && (firstLine.charCodeAt(k) === 32 || firstLine.charCodeAt(k) === 9)) k++;
        if (k > 0 && firstLine.slice(0, k).indexOf('\t') !== -1) {
          let col = cur.col;
          let seenQ2 = false, outCols2 = 0;
          for (let b = cont; b && b.t !== 'doc'; b = b.parent) {
            if (b.t === 'quote') seenQ2 = true;
            else if (b.t === 'item' && seenQ2) outCols2 += b.contentIndent;
          }
          if (seenQ2) col -= outCols2;
          firstLine = expandLeadingTabs(firstLine, col);
        }
      }
      const p = addChild(cont, { t: 'para', lines: [firstLine], lastLazy: false, children: [] }, li);
      open.push(p);
      break;
    }
  }

  // close everything left open
  closeAbove(1);
  return { doc, refs, blankLines, totalLines, endsNL, lines };
}

function peekAfterSpaces(cur) {
  const save = cur.save();
  const ind = cur.indent();
  cur.adv(ind);
  const c = cur.ch();
  cur.restore(save);
  return c;
}

// expand leading tabs in s to spaces (tab stops of 4), starting at column col
function expandLeadingTabs(s, col) {
  let i = 0, out = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) { const w = 4 - (col & 3); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return i === 0 ? s : out + s.slice(i);
}

// Content-start column for a fence's tab expansion: 2 when inside any
// blockquote (nested quotes do not add), plus the list-item content
// indents of ancestors. Also returns the number of quote ancestors and
// the item indents inside the innermost quote (below it).
function fenceTabBase(leaf) {
  let quotes = 0, itemCols = 0, itemColsInside = 0, seenQuote = false;
  for (let b = leaf.parent; b && b.t !== 'doc'; b = b.parent) {
    if (b.t === 'quote') { quotes++; seenQuote = true; }
    else if (b.t === 'item') {
      itemCols += b.contentIndent || 0;
      if (!seenQuote) itemColsInside += b.contentIndent || 0;
    }
  }
  return { quotes, base: (quotes > 0 ? 2 : 0) + itemCols, itemCols, itemColsInside };
}

// Can a block starting at cur interrupt a paragraph? (ATX, fence, HTML 1-6,
// thematic break, blockquote, list with non-empty first item.)
function startsInterrupt(cur, inPara, paraInItem) {
  const save = cur.save();
  const ind = cur.indent();
  if (ind > 3) { cur.restore(save); return false; }
  cur.adv(ind);
  const s = cur.s, i = cur.i;
  if (atxHeading(s, i)) { cur.restore(save); return true; }
  if (fenceStart(s, i)) { cur.restore(save); return true; }
  if (s.charCodeAt(i) === 60) {
    const hb = htmlBlockStart(s, i);
    if (hb && hb <= 6) { cur.restore(save); return true; }
  }
  if (isThematicBreak(s, i)) { cur.restore(save); return true; }
  if (s.charCodeAt(i) === 62) { cur.restore(save); return true; }
  const li = listItemStart(cur);
  // a list item interrupts a paragraph only when its first item is
  // non-empty; an ordered list only when it starts with 1, except that
  // a paragraph directly inside a list item is interrupted by an
  // ordered list with any start number
  if (li && !li.empty && (!li.ordered || li.start === 1 || paraInItem)) { cur.restore(save); return true; }
  cur.restore(save);
  return false;
}

// ---------------------------------------------------------------- inline parsing

// Render text with numeric character references decoded and the no-encode
// escape rule applied (see the escape section above).
function renderText(s) {
  let out = '';
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const dec = decodeNumericRef(s, i);
      if (dec) {
        // decoded char, escaped with the plain rules (no lookahead)
        const ch = dec[0];
        const cc = ch.charCodeAt(0);
        let rep = ch;
        if (cc === 38) rep = '&amp;';
        else if (cc === 34) rep = '&quot;';
        else if (cc === 39) rep = '&#39;';
        else if (cc === 60) rep = '&lt;';
        else if (cc === 62) rep = '&gt;';
        out += s.slice(start, i) + rep;
        i = dec[1]; start = i;
        continue;
      }
      // named-entity-shaped? leave alone
      let j = i + 1;
      while (j < n && isAlnum(s.charCodeAt(j))) j++;
      if (j > i + 1 && s.charCodeAt(j) === 59) { i = j + 1; continue; }
      out += s.slice(start, i) + '&amp;';
      i++; start = i;
      continue;
    }
    if (c === 34) { out += s.slice(start, i) + '&quot;'; i++; start = i; continue; }
    if (c === 39) { out += s.slice(start, i) + '&#39;'; i++; start = i; continue; }
    if (c === 60) { out += s.slice(start, i) + '&lt;'; i++; start = i; continue; }
    if (c === 62) { out += s.slice(start, i) + '&gt;'; i++; start = i; continue; }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

function isUnicodeWhitespace(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

// Flanking info for a delimiter run at s[i..i+len).
function flanking(s, i, len) {
  const before = i > 0 ? s.charCodeAt(i - 1) : -1;
  const after = i + len < s.length ? s.charCodeAt(i + len) : -1;
  const beforeWS = before === -1 || isUnicodeWhitespace(before);
  const afterWS = after === -1 || isUnicodeWhitespace(after);
  const beforePunct = before !== -1 && isPunct(before);
  const afterPunct = after !== -1 && isPunct(after);
  const leftFlanking = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const rightFlanking = !beforeWS && (!beforePunct || afterWS || afterPunct);
  return { leftFlanking, rightFlanking, beforePunct, afterPunct };
}

// Match an email address starting at s[i]. Returns the index just past it, or 0.
// local: [a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+
// domain: label(.label)* where labels start/end alnum, interior may have -
function matchEmail(s, i) {
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
        c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 ||
        c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45) j++;
    else break;
  }
  if (j === i || s.charCodeAt(j) !== 64) return 0; // need @
  const at = j;
  j++;
  // domain labels
  let labels = 0;
  while (true) {
    const ls = j;
    while (j < s.length && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 45)) j++;
    if (j === ls) return 0;
    if (!isAlnum(s.charCodeAt(ls)) || !isAlnum(s.charCodeAt(j - 1))) return 0;
    labels++;
    if (s.charCodeAt(j) === 46 && isAlnum(s.charCodeAt(j + 1))) { j++; continue; }
    break;
  }
  if (labels === 0) return 0;
  // the char before @ must not be '.' and the local part must not end with '.'
  if (s.charCodeAt(at - 1) === 46) return 0;
  return j;
}

// GFM bare-email match (marked's url-rule email):
// [A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])
// Domain labels after the first may contain _ and -, but each must end
// with an alphanumeric char; the whole email must not be followed by a
// word char or -. If it is, backtrack by dropping trailing .label
// groups (so because@mark.example.com__ links because@mark.example,
// and foo@bar.com__ links nothing at all).
// Exception: a trailing _ run that closes a _ opener collected before
// the email is a delimiter boundary (marked tokenizes emphasis content
// separately, so the email never sees it) — the full email stands.
function matchBareEmail(s, i, delims) {
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
        c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 ||
        c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45) j++;
    else break;
  }
  if (j === i || s.charCodeAt(j) !== 64) return 0; // need @
  const at = j;
  j++;
  // first domain label: [a-zA-Z0-9-_]+
  const fs = j;
  while (j < s.length && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 45 || s.charCodeAt(j) === 95)) j++;
  if (j === fs) return 0;
  // .label groups: \.[a-zA-Z0-9-_]*[a-zA-Z0-9]; record each group's end
  const ends = [];
  while (s.charCodeAt(j) === 46) {
    let k = j + 1, lastAlnum = -1;
    while (k < s.length && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 45 || s.charCodeAt(k) === 95)) {
      if (isAlnum(s.charCodeAt(k))) lastAlnum = k;
      k++;
    }
    if (lastAlnum === -1) break;
    ends.push(lastAlnum + 1);
    j = lastAlnum + 1;
  }
  if (ends.length === 0) return 0; // need at least one .label (a dot)
  if (s.charCodeAt(at - 1) === 46) return 0; // local part must not end with '.'
  // backtrack: longest match first; drop trailing .label groups until
  // the next char is not a word char or '-'
  for (let e = ends.length - 1; e >= 0; e--) {
    const end = ends[e];
    const nc = end < s.length ? s.charCodeAt(end) : -1;
    if (nc === -1 || !(isAlnum(nc) || nc === 95 || nc === 45)) return end;
    // a trailing _ run that closes a _ opener seen before this email
    // is an emphasis delimiter, not part of the word: keep the match
    if (nc === 95 && delims) {
      let j2 = end;
      while (s.charCodeAt(j2) === 95) j2++;
      const fl = flanking(s, end, j2 - end);
      const canClose = fl.rightFlanking && (!fl.leftFlanking || fl.afterPunct);
      if (canClose) {
        for (const d of delims) if (d.ch === '_' && d.canOpen) return end;
      }
    }
  }
  return 0;
}

// For a raw HTML tag string, return 'open' if it opens a link context
// for extended-autolink suppression, 'close' if it closes it, else
// null. Marked's rule is startATag /^<a /i (an <a> followed by a
// space — so bare <a> and <a/> do NOT open, but <a /> and <a href>
// do) and endATag /^<\/a>/i.
function aTagState(html) {
  if (html.charCodeAt(0) !== 60) return null;
  if (html.charCodeAt(1) === 47) { // </a>
    const c = html.charCodeAt(2);
    if ((c === 97 || c === 65) && html.charCodeAt(3) === 62) return 'close';
    return null;
  }
  const c = html.charCodeAt(1);
  if ((c === 97 || c === 65) && html.charCodeAt(2) === 32) return 'open';
  return null;
}

// Try to match an autolink or raw HTML tag at s[i] === '<'.
// Returns {html, next}, {link, next}, or null.
function parseAngle(s, i) {
  const j = i + 1;
  // autolink: <scheme:...>
  if (isAlpha(s.charCodeAt(j))) {
    let k = j + 1;
    while (k < s.length && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 43 || s.charCodeAt(k) === 46 || s.charCodeAt(k) === 45)) k++;
    if (k - j >= 2 && k - j <= 32 && s.charCodeAt(k) === 58) {
      let m = k + 1;
      while (m < s.length && s.charCodeAt(m) !== 62 && s.charCodeAt(m) !== 32 && s.charCodeAt(m) !== 10 && s.charCodeAt(m) >= 32) m++;
      if (s.charCodeAt(m) === 62 && m > k + 1) {
        const uri = s.slice(i + 1, m);
        return { link: { dest: uri, text: uri }, next: m + 1 };
      }
      return null;
    }
  }
  // email autolink
  const em = matchEmail(s, j);
  if (em && s.charCodeAt(em) === 62) {
    const addr = s.slice(j, em);
    return { link: { dest: 'mailto:' + addr, text: addr }, next: em + 1 };
  }
  // raw HTML
  if (s.charCodeAt(j) === 33) { // !
    if (s.charCodeAt(j + 1) === 45 && s.charCodeAt(j + 2) === 45) {
      // comment
      let m = j + 3;
      if (s.charCodeAt(m) === 62) return { html: s.slice(i, m + 1), next: m + 1 };
      if (s.charCodeAt(m) === 45 && s.charCodeAt(m + 1) === 62) return { html: s.slice(i, m + 2), next: m + 2 };
      while (m < s.length) {
        if (s.charCodeAt(m) === 45 && s.charCodeAt(m + 1) === 45) {
          if (s.charCodeAt(m + 2) === 62) return { html: s.slice(i, m + 3), next: m + 3 };
          // -- inside a comment does not end it (marked is lenient here)
        }
        m++;
      }
      return null;
    }
    if (s.slice(j + 1, j + 8) === '[CDATA[') {
      const m = s.indexOf(']]>', j + 8);
      if (m === -1) return null;
      return { html: s.slice(i, m + 3), next: m + 3 };
    }
    const c = s.charCodeAt(j + 1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      // declaration: up to the next >
      const m = s.indexOf('>', j + 1);
      if (m === -1) return null;
      return { html: s.slice(i, m + 1), next: m + 1 };
    }
    return null;
  }
  if (s.charCodeAt(j) === 63) { // <? ... ?>
    const m = s.indexOf('?>', j + 1);
    if (m === -1) return null;
    return { html: s.slice(i, m + 2), next: m + 2 };
  }
  // open or close tag
  let k = j;
  let closing = false;
  if (s.charCodeAt(k) === 47) { closing = true; k++; }
  if (!isAlpha(s.charCodeAt(k))) return null;
  while (k < s.length && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 45)) k++;
  if (closing) {
    while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (s.charCodeAt(k) !== 62) return null;
    return { html: s.slice(i, k + 1), next: k + 1 };
  }
  // attributes
  while (true) {
    while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (s.charCodeAt(k) === 62) return { html: s.slice(i, k + 1), next: k + 1 };
    if (s.charCodeAt(k) === 47 && s.charCodeAt(k + 1) === 62) return { html: s.slice(i, k + 2), next: k + 2 };
    if (k >= s.length) return null;
    // attribute name (must start with a letter, _, or digit; : is allowed
    // inside a name but not as the first character)
    const ac = s.charCodeAt(k);
    if (!(isAlpha(ac) || ac === 95 || isDigit(ac))) return null;
    while (k < s.length) {
      const d = s.charCodeAt(k);
      if (isAlnum(d) || d === 95 || d === 58 || d === 46 || d === 45) k++;
      else break;
    }
    while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (s.charCodeAt(k) === 61) {
      k++;
      while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
      const q = s.charCodeAt(k);
      if (q === 34 || q === 39) {
        k++;
        while (k < s.length && s.charCodeAt(k) !== q) k++;
        if (k >= s.length) return null;
        k++;
        // after a quoted value there must be whitespace, > or / (not a
        // letter glued onto the value)
        const after = s.charCodeAt(k);
        if (!(k >= s.length || after === 32 || after === 9 || after === 10 || after === 62 || after === 47)) return null;
      } else {
        // unquoted value: no spaces, ", ', =, <, >, `
        let vn = 0;
        while (k < s.length) {
          const d = s.charCodeAt(k);
          if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          k++; vn++;
        }
        if (vn === 0) return null;
      }
    }
  }
}

// ---------------------------------------------------------------- extended autolinks (GFM)

// Match a domain starting at s[i]: labels of [a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?
// separated by '.', at least two labels. For www/scheme autolinks the last
// label must be >= 2 letters only; for email domains any valid label works.
// Returns the end index or 0.
function matchDomain(s, i) {
  // Mirror marked's (?:[a-zA-Z0-9\-]+\.?)+ : one or more labels of
  // alphanumerics/hyphens (a label may start or end with '-'), each
  // optionally followed by a dot. No minimum label count, no last-label
  // length or alpha requirement (http://outer, http://a.b, http://x.1,
  // http://-foo and www.-foo all autolink).
  let j = i, n = 0;
  while (true) {
    const ls = j;
    while (j < s.length && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 45)) j++;
    if (j === ls) break;
    n++;
    if (s.charCodeAt(j) === 46) j++;
    else break;
  }
  return n === 0 ? 0 : j;
}

// Case-insensitive compare of s[i..i+t.length) with the lowercase string t.
function eqFold(s, i, t) {
  for (let q = 0; q < t.length; q++) {
    let c = s.charCodeAt(i + q);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== t.charCodeAt(q)) return false;
  }
  return true;
}

// Trim trailing punctuation off a matched autolink text [start, end).
// A trailing entity (&word;) is not part of the link either.
// Returns the new end index.
function trimAutolink(s, start, end) {
  // A '(' with no ')' after it ends the URL: marked's backpedal can only
  // match '(' as part of a \([^)]*\) group, so the match stops at the
  // first such '('.
  let lastClose = -1;
  for (let k = end - 1; k >= start; k--) if (s.charCodeAt(k) === 41) { lastClose = k; break; }
  if (lastClose !== -1) {
    for (let k = lastClose + 1; k < end; k++) if (s.charCodeAt(k) === 40) { end = k; break; }
  } else {
    for (let k = start; k < end; k++) if (s.charCodeAt(k) === 40) { end = k; break; }
  }
  // trailing entity: &word;
  if (end > start && s.charCodeAt(end - 1) === 59) {
    let k = end - 2;
    while (k >= start && isAlnum(s.charCodeAt(k))) k--;
    if (k >= start && s.charCodeAt(k) === 38 && k < end - 1) end = k;
  }
  // Walk back over trailing punctuation. A ')' is kept only if it closes
  // a '(' with no ')' between them (a one-level \([^)]*\) group);
  // '(' itself, and ' and ", are trailing punctuation.
  while (end > start) {
    const c = s.charCodeAt(end - 1);
    if (c === 41) { // ')'
      let k = end - 2, open = -1;
      while (k >= start) {
        const ck = s.charCodeAt(k);
        if (ck === 41) break; // another ')' in between: not a group
        if (ck === 40) { open = k; break; }
        k--;
      }
      if (open !== -1) break; // this ')' closes a group: keep it
      end--; continue;
    }
    if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
        c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 40) { end--; continue; }
    break;
  }
  return end;
}

// Try an extended autolink at s[i] (prev = char code before i, or -1).
// inBracket: the position is inside a live [ bracket, so the URL ends
// at a [ or ] (that bracket's delimiter), not beyond it.
// Returns {dest, text, next} or null.
function matchExtended(s, i, prev, delims, inBracket) {
  const wordChar = (c) => isAlnum(c) || c === 95;
  // www.
  if (s.charCodeAt(i) === 119 && s.slice(i, i + 4) === 'www.') {
    if (prev !== -1 && (wordChar(prev) || prev === 47)) return null;
    const d = matchDomain(s, i);
    if (!d) return null;
    let end = d;
    // after the domain the URL may continue with a path, query,
    // fragment, or port: extend to the first whitespace, <, or control
    // (inside a live bracket a [ or ] also ends it: it delimits link
    // syntax, not the URL)
    while (end < s.length) {
      const c = s.charCodeAt(end);
      if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
      if (inBracket && (c === 91 || c === 93)) break;
      end++;
    }
    end = trimAutolink(s, i, end);
    if (end <= i + 4) return null;
    const text = s.slice(i, end);
    return { dest: 'http://' + text, text, next: end };
  }
  // scheme:// or scheme:email
  if (isAlpha(s.charCodeAt(i))) {
    let k = i + 1;
    while (k < s.length && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 43 || s.charCodeAt(k) === 46 || s.charCodeAt(k) === 45)) k++;
    if (k - i >= 2 && k - i <= 32 && s.charCodeAt(k) === 58) {
      if (prev !== -1 && (wordChar(prev) || prev === 47)) return null;
      const scheme = s.slice(i, k);
      // scheme:email — only lowercase mailto: and xmpp: (marked's At);
      // any other scheme leaves the bare email to match on its own.
      if (scheme === 'mailto' || scheme === 'xmpp') {
        const em = matchBareEmail(s, k + 1, delims);
        if (em) {
          const at = s.indexOf('@', k + 1);
          if (at !== -1 && at < em) {
            let end = em;
            // an xmpp-style resource path (/txt) is part of the link, but
            // only one segment, and a bare trailing / is not
            if (s.charCodeAt(end) === 47) {
              let p = end + 1;
              while (p < s.length) {
                const c = s.charCodeAt(p);
                if (c === 32 || c === 9 || c === 10 || c === 60 || c === 47 || c < 32) break;
                p++;
              }
              if (p > end + 1) end = trimAutolink(s, i, p);
            }
            const text = s.slice(i, end);
            return { dest: text, text, next: end };
          }
        }
        return null;
      }
      // scheme:// — only http, https, ftp (marked's Re), case-insensitive.
      const sl = scheme.length;
      const isUrlScheme = (sl === 3 && eqFold(s, i, 'ftp')) ||
        (sl === 4 && eqFold(s, i, 'http')) || (sl === 5 && eqFold(s, i, 'https'));
      if (!isUrlScheme) return null;
      if (s.slice(k, k + 3) !== '://') return null;
      const d = matchDomain(s, k + 3);
      if (!d) return null;
      let end = d;
      // after the domain the URL may continue with a path, query,
      // fragment, or port: extend to the first whitespace, <, or control
      // (inside a live bracket a [ or ] also ends it: it delimits link
      // syntax, not the URL)
      while (end < s.length) {
        const c = s.charCodeAt(end);
        if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
        if (inBracket && (c === 91 || c === 93)) break;
        end++;
      }
      end = trimAutolink(s, i, end);
      const text = s.slice(i, end);
      return { dest: text, text, next: end };
    }
  }
  // email
  if (prev !== -1 && (wordChar(prev) || prev === 47)) return null;
  const em = matchBareEmail(s, i, delims);
  if (em) {
    const addr = s.slice(i, em);
    return { dest: 'mailto:' + addr, text: addr, next: em };
  }
  return null;
}

// Label text from the items between a bracket and ']' (for shortcut refs):
// plain text of the items, with emphasis delimiters as their literal chars.
function labelFromItems(items, bIdx) {
  let s = '';
  for (let k = bIdx + 1; k < items.length; k++) {
    const it = items[k];
    if (it.k === 't') s += it.s;
    else if (it.k === 'auto') s += it.text;
    else if (it.k === 'code') s += it.s;
    else if (it.k === 'delim') s += it.ch.repeat(it.origN);
    else if (it.k === 'bracket') s += it.image ? '![' : '[';
    else if (it.k === 'link' || it.k === 'image') s += labelFromItems(it.children, -1);
    else if (it.k === 'nl' || it.k === 'br') s += '\n';
    else if (it.k === 'html') s += it.s;
  }
  return s;
}

function parseInline(text, refs, ctx) {
  const items = [];
  const delims = [];
  const brackets = [];
  let seq = 0;
  let linkId = 0;
  let i = 0;
  let textStart = 0;
  const n = text.length;
  const flushText = (end) => {
    if (end > textStart) items.push({ k: 't', s: text.slice(textStart, end) });
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92) { // backslash
      const d = text.charCodeAt(i + 1);
      if (d === 10) { flushText(i); items.push({ k: 'br' }); i += 2; while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++; textStart = i; continue; }
      if (d !== -1 && isAsciiPunct(d)) {
        flushText(i);
        items.push({ k: 't', s: text[i + 1] });
        i += 2; textStart = i; continue;
      }
      i++; continue;
    }
    if (c === 96) { // code span
      let j = i;
      while (text.charCodeAt(j) === 96) j++;
      const len = j - i;
      let k = j, found = -1;
      while (k < n) {
        const ch = text.charCodeAt(k);
        if (ch === 93) { // ]
          // A code span may not extend past the ']' closing a bracket
          // when the bracket's label is valid and this opening backtick
          // is claimed by a code span inside that label (the link then
          // forms and the span stays inside it). A lone backtick in the
          // label, or an invalid label, lets the span cross the ']'.
          let stop = false;
          for (let b = brackets.length - 1; b >= 0; b--) {
            if (!brackets[b].active) continue;
            const lab = text.slice(brackets[b].pos + 1, k);
            if (lab.indexOf('`') !== -1 && labelTextValid(lab)) {
              const off = i - (brackets[b].pos + 1);
              const spans = labelCodeSpans(lab);
              for (const sp of spans) {
                if (off >= sp[0] && off < sp[1]) { stop = true; break; }
              }
            }
            break; // only the innermost open bracket matters
          }
          if (stop) break;
          k++; continue;
        }
        if (ch === 96) {
          let m = k;
          while (text.charCodeAt(m) === 96) m++;
          if (m - k === len) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found === -1) { i = j; continue; }
      let content = text.slice(j, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && !/^[ ]+$/.test(content)) {
        content = content.slice(1, -1);
      }
      flushText(i);
      items.push({ k: 'code', s: content });
      i = found + len; textStart = i;
      continue;
    }
    if (c === 42 || c === 95) { // * or _ delimiter run
      let j = i;
      while (text.charCodeAt(j) === c) j++;
      const len = j - i;
      const fl = flanking(text, i, len);
      let canOpen, canClose;
      if (c === 42) { canOpen = fl.leftFlanking; canClose = fl.rightFlanking; }
      else {
        canOpen = fl.leftFlanking && (!fl.rightFlanking || fl.beforePunct);
        canClose = fl.rightFlanking && (!fl.leftFlanking || fl.afterPunct);
      }
      flushText(i);
      const tok = { k: 'delim', ch: String.fromCharCode(c), n: len, origN: len, openUses: [], closeUses: [], canOpen, canClose, pos: i, link: 0 };
      items.push(tok);
      delims.push(tok);
      i = j; textStart = i;
      continue;
    }
    if (c === 126) { // ~ run: strikethrough delimiter when 1 or 2 long
      let j = i;
      while (text.charCodeAt(j) === 126) j++;
      const len = j - i;
      if (len === 1 || len === 2) {
        const fl = flanking(text, i, len);
        flushText(i);
        const tok = { k: 'delim', ch: '~', n: len, origN: len, openUses: [], closeUses: [], canOpen: fl.leftFlanking, canClose: fl.rightFlanking, pos: i, link: 0 };
        items.push(tok);
        delims.push(tok);
        i = j; textStart = i;
        continue;
      }
      i = j; continue;
    }
    if (c === 91 || (c === 33 && text.charCodeAt(i + 1) === 91)) { // [ or ![
      const image = c === 33;
      flushText(i);
      const tok = { k: 'bracket', image, active: true, live: true, seq: seq++, pos: image ? i + 1 : i };
      items.push(tok);
      brackets.push(tok);
      i += image ? 2 : 1; textStart = i;
      continue;
    }
    if (c === 93) { // ]
      let b = null;
      for (let k = brackets.length - 1; k >= 0; k--) if (brackets[k].active) { b = brackets[k]; break; }
      if (!b) { i++; continue; }
      flushText(i);
      const bIdx = items.indexOf(b);
      let hasLink = false;
      for (let k = bIdx + 1; k < items.length; k++) {
        // an angle autolink inside does not block an enclosing link
        if (items[k].k === 'link' && !items[k].angle) { hasLink = true; break; }
      }
      // A label containing a backtick must match marked's label regex:
      // a code span like `` a ` b `` (backtick in its content) makes the
      // whole label unmatchable, so the link (or image) cannot form.
      let labelBad = false;
      {
        const lab = text.slice(b.pos + 1, i);
        if (lab.indexOf('`') !== -1 && !labelTextValid(lab)) labelBad = true;
      }
      let dest = null, title = null, next = -1;
      // a link's text may not contain a link (but it may contain an image);
      // an image description may contain either
      if ((!hasLink || b.image) && !labelBad) {
        if (text.charCodeAt(i + 1) === 40) { // ( inline link
          const j = skipWSNL(text, i + 2);
          const d = parseLinkDest(text, j);
          if (d) {
            const afterDest = text.charCodeAt(d.next);
            if (afterDest === 41) { // ) right after the destination
              dest = d.dest; title = null; next = d.next + 1;
            } else if (afterDest === 32 || afterDest === 9 || afterDest === 10) {
              // whitespace before an optional title (a title needs the space)
              let k = skipWSNL(text, d.next);
              let t = null, ok = true;
              const q = text.charCodeAt(k);
              if (q === 34 || q === 39 || q === 40) {
                const tt = parseLinkTitle(text, k);
                if (tt) { t = tt.title; k = skipWSNL(text, tt.next); }
                else ok = false;
              }
              if (ok && text.charCodeAt(k) === 41) { dest = d.dest; title = t; next = k + 1; }
            }
            // otherwise junk after the destination: no link
          }
        }
        if (dest === null && text.charCodeAt(i + 1) === 91) { // [label]
          const lab = parseLinkLabel(text, i + 1);
          if (lab) {
            // an empty label is a collapsed reference: the label is the
            // link text itself (raw, between the brackets)
            const key = lab.label.length === 0 ? normalizeLabel(text.slice(b.pos + 1, i)) : normalizeLabel(lab.label);
            const ref = refs.get(key);
            if (ref) { dest = ref.dest; title = ref.title; next = lab.next; }
          }
        }
        if (dest === null) { // shortcut (not when a [label] was attempted)
          if (text.charCodeAt(i + 1) !== 91) {
            const key = normalizeLabel(text.slice(b.pos + 1, i));
            const ref = refs.get(key);
            if (ref) { dest = ref.dest; title = ref.title; next = i + 1; }
          }
        }
      }
      if (dest !== null && cleanUrl(dest) !== null) {
        const children = items.slice(bIdx + 1);
        // mark the delimiters inside this link/image with its scope id,
        // so emphasis cannot pair across the link boundary (a delimiter
        // already inside a nested link keeps the inner id)
        linkId++;
        for (const ch of children) if (ch.k === 'delim' && !ch.link) ch.link = linkId;
        items.length = bIdx;
        items.push({ k: b.image ? 'image' : 'link', dest, title, children });
        for (const br of brackets) if (br.seq > b.seq) br.active = false;
        // A link's text may not contain a link, so once a LINK forms
        // inside an enclosing link bracket, that bracket can never form
        // a link either: mark it dead for autolink purposes (it stays
        // active so its ']' still closes it, not an outer bracket).
        // (An image description may contain a link, so image brackets
        // stay live.)
        if (!b.image) for (const br of brackets) if (br.seq < b.seq && br.active && !br.image) br.live = false;
        b.active = false;
        i = next; textStart = i;
        continue;
      }
      if (labelBad) {
        // A label with a code span containing a backtick cannot form a
        // link, and marked leaves the emphasis delimiters inside it
        // literal too: disable them so they cannot pair.
        for (let k = bIdx + 1; k < items.length; k++) {
          if (items[k].k === 'delim') { items[k].canOpen = false; items[k].canClose = false; }
        }
      }
      b.active = false;
      // the flushed text item stays; the ] itself becomes pending text
      textStart = i; i++; continue;
    }
    if (c === 60) { // < autolink or raw html
      const a = parseAngle(text, i);
      if (a) {
        flushText(i);
        // an angle autolink may sit inside a link's text: it does not
        // block an enclosing link, so it is marked as such
        if (a.link) items.push({ k: 'link', dest: a.link.dest, title: null, angle: true, children: [{ k: 't', s: a.link.text }] });
        else {
          items.push({ k: 'html', s: a.html });
          // an unclosed <a> tag suppresses later extended autolinks
          // (www/scheme/email) until a </a> closes it (marked quirk)
          if (ctx) {
            const st = aTagState(a.html);
            if (st === 'open') ctx.inA = true;
            else if (st === 'close') ctx.inA = false;
          }
        }
        i = a.next; textStart = i;
        continue;
      }
      i++; continue;
    }
    if (c === 10) { // newline: hard break (2+ spaces) or soft break
      let j = i - 1, spaces = 0;
      while (j >= textStart && text.charCodeAt(j) === 32) { spaces++; j--; }
      if (spaces >= 2) {
        flushText(i - spaces);
        items.push({ k: 'br' });
      } else {
        flushText(i);
        items.push({ k: 'nl' });
      }
      i++;
      // after a hard break, leading spaces/tabs on the next line are skipped
      if (spaces >= 2) while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
      textStart = i;
      continue;
    }
    // extended autolink (GFM): only when not inside a word, and not
    // inside an unclosed <a> tag (marked suppresses them there)
    if ((i === 0 || (!isAlnum(text.charCodeAt(i - 1)) && text.charCodeAt(i - 1) !== 95 && text.charCodeAt(i - 1) !== 47)) && !(ctx && ctx.inA)) {
      if (c === 119 || isAlpha(c) || isDigit(c)) {
        const prev = i === 0 ? -1 : text.charCodeAt(i - 1);
        let inBracket = false;
        for (let k = brackets.length - 1; k >= 0; k--) if (brackets[k].active && brackets[k].live) { inBracket = true; break; }
        const ea = matchExtended(text, i, prev, delims, inBracket);
        if (ea) {
          flushText(i);
          // inside an open bracket the autolink is deferred: it stays
          // plain text if the bracket becomes a link, and only becomes
          // a link itself if the bracket does not (resolved at the end)
          if (inBracket) items.push({ k: 'auto', dest: ea.dest, text: ea.text });
          else items.push({ k: 'link', dest: ea.dest, title: null, children: [{ k: 't', s: ea.text }] });
          i = ea.next; textStart = i;
          continue;
        }
      }
    }
    i++;
  }
  flushText(n);
  // deferred extended autolinks that were never absorbed into a link
  // become real links now
  for (let k = 0; k < items.length; k++) {
    if (items[k].k === 'auto') items[k] = { k: 'link', dest: items[k].dest, title: null, children: [{ k: 't', s: items[k].text }] };
  }
  processEmphasis(delims);
  return renderItems(items);
}

// Forward m-scan (marked's emStrong): can the closer at ci close the
// opener at oi? Scans delimiters oi+1..ci (text order, original lengths):
// m starts at the opener's length; a pure opener adds its length, a
// both-delimiter subtracts unless the rule of 3 skips it, a pure closer
// subtracts. If m reaches <= 0 before ci the opener pairs earlier, so
// ci cannot close it; if m is still > 0 at ci, ci is insufficient.
function mCanPair(delims, oi, ci, spans) {
  const opener = delims[oi];
  // A delimiter inside an already-formed pair of a DIFFERENT character
  // A delimiter inside an already-formed pair of a DIFFERENT character
  // was processed as that pair's content; it does not inflate what this
  // closer must cover. (A same-character span's delimiters still count.)
  const inSpan = (d) => {
    for (const sp of spans) if (sp.ch !== opener.ch && sp.start < d.pos && d.pos < sp.end) return true;
    return false;
  };
  // With no same-character delimiter between opener and closer, a
  // partial use is fine (the run is split); the m-scan only matters
  // when intermediates inflate what the closer must cover.
  let hasMid = false;
  for (let k = oi + 1; k < ci; k++) {
    if (inSpan(delims[k])) continue;
    if (delims[k].ch === opener.ch && delims[k].link === opener.link) { hasMid = true; break; }
  }
  if (!hasMid) return true;
  let m = opener.origN;
  const y = opener.origN;
  for (let k = oi + 1; k <= ci; k++) {
    const d = delims[k];
    if (d.ch !== opener.ch) continue;
    if (d.link !== opener.link) continue;
    const b = d.origN;
    if (d.canOpen && !d.canClose) m += b;
    else if (d.canOpen && d.canClose) {
      if (y % 3 !== 0 && (y + b) % 3 === 0) continue;
      m -= b;
    } else if (d.canClose) m -= b;
    if (m <= 0) return k === ci;
  }
  return false;
}

// Emphasis processing: match closers (from the end) with openers.
function processEmphasis(delims) {
  // Closers are processed in document order (first to last); for each
  // closer, the nearest preceding opener of the same character is used.
  // A closer cannot pair with an opener across a link/image boundary
  // (different link scope) or across a closed emphasis span (an opener
  // inside a span the closer is outside of).
  const spans = [];
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.canClose || closer.n === 0) continue;
    // find the nearest preceding opener of the same char
    for (let oi = ci - 1; oi >= 0; oi--) {
      const opener = delims[oi];
      if (opener.ch !== closer.ch) continue;
      if (opener.link !== closer.link) continue; // across a link/image boundary
      if (opener.n === 0 || !opener.canOpen) continue;
      let insideSpan = false;
      for (const sp of spans) {
        if (sp.start < opener.pos && opener.pos < sp.end && closer.pos > sp.end) { insideSpan = true; break; }
      }
      if (insideSpan) continue;
      if (opener.ch === '~') {
        // strikethrough: opener and closer must be the same length (1 or 2)
        if (opener.n !== closer.n) continue;
      } else if ((opener.canOpen && opener.canClose || closer.canOpen && closer.canClose) &&
          (opener.n + closer.n) % 3 === 0 &&
          !(opener.n % 3 === 0 && closer.n % 3 === 0)) {
        // rule of 3: if either delimiter can both open and close, and
        // the sum of the run lengths is a multiple of 3 (without both
        // lengths being multiples of 3), this pair cannot match
        continue;
      } else if (!mCanPair(delims, oi, ci, spans)) {
        // m-scan: the closer is insufficient to close this opener
        // (inner pure openers inflate what it must cover)
        continue;
      }
      const use = opener.ch === '~' ? opener.n : (opener.n >= 2 && closer.n >= 2 ? 2 : 1);
      opener.openUses.push({ partner: closer, use });
      closer.closeUses.push({ partner: opener, use });
      opener.n -= use;
      closer.n -= use;
      spans.push({ start: opener.pos, end: closer.pos, ch: opener.ch });
      if (closer.n > 0) { ci--; } // this closer can match another opener
      break;
    }
  }
}

// ---------------------------------------------------------------- rendering

function renderItems(items) {
  let out = '';
  for (const it of items) {
    if (it.k === 't') out += renderText(it.s);
    else if (it.k === 'auto') out += renderText(it.text);
    else if (it.k === 'code') out += '<code>' + escapeCode(it.s) + '</code>';
    else if (it.k === 'html') out += it.s;
    else if (it.k === 'br') out += '<br>';
    else if (it.k === 'nl') out += '\n';
    else if (it.k === 'bracket') out += it.image ? '![' : '[';
    else if (it.k === 'link') {
      const href = cleanUrl(it.dest);
      out += '<a href="' + escapeAttr(href === null ? it.dest : href) + '"';
      if (it.title !== null && it.title !== undefined) out += ' title="' + escapeAttr(it.title) + '"';
      out += '>' + renderItems(it.children) + '</a>';
    } else if (it.k === 'image') {
      const src = cleanUrl(it.dest);
      out += '<img src="' + escapeAttr(src === null ? it.dest : src) + '" alt="' + renderAlt(it.children) + '"';
      if (it.title !== null && it.title !== undefined) out += ' title="' + escapeAttr(it.title) + '"';
      out += '>';
    } else if (it.k === 'delim') {
      const tag = it.ch === '~' ? 'del' : null;
      for (const u of it.closeUses) out += tag ? '</del>' : (u.use === 2 ? '</strong>' : '</em>');
      if (it.n > 0) out += it.ch.repeat(it.n);
      for (let k = it.openUses.length - 1; k >= 0; k--) {
        const u = it.openUses[k];
        out += tag ? '<del>' : (u.use === 2 ? '<strong>' : '<em>');
      }
    }
  }
  return out;
}

// Plain-text rendering of inline items (for image alt text): no tags,
// emphasis delimiters as their literal characters.
function renderAlt(items) {
  let out = '';
  for (const it of items) {
    if (it.k === 't') out += renderText(it.s);
    else if (it.k === 'auto') out += renderText(it.text);
    else if (it.k === 'code') out += escapeCode(it.s);
    else if (it.k === 'html') out += it.s;
    else if (it.k === 'br' || it.k === 'nl') out += ' ';
    else if (it.k === 'bracket') out += it.image ? '![' : '[';
    else if (it.k === 'link' || it.k === 'image') out += renderAlt(it.children);
    else if (it.k === 'delim') out += it.ch.repeat(it.n);
  }
  return out;
}

// Task list marker at the start of an item's first paragraph text:
// "[ ] " or "[x] " / "[X] " followed by a space or end. Returns
// {checked, rest} or null.
function taskMarker(text) {
  if (text.charCodeAt(0) !== 91) return null;
  const c = text.charCodeAt(1);
  if ((c === 32 || c === 120 || c === 88) && text.charCodeAt(2) === 93) {
    if (text.length === 3) return { checked: c === 120 || c === 88, rest: '' };
    if (text.charCodeAt(3) === 32) return { checked: c === 120 || c === 88, rest: text.slice(4) };
  }
  return null;
}

function renderBlock(blk, refs, ctx) {
  switch (blk.t) {
    case 'doc': {
      let out = '';
      for (const ch of blk.children) out += renderBlock(ch, refs, ctx);
      return out;
    }
    case 'para': {
      return '<p>' + parseInline(blk.text, refs, ctx) + '</p>\n';
    }
    case 'heading': {
      return '<h' + blk.level + '>' + parseInline(blk.text, refs, ctx) + '</h' + blk.level + '>\n';
    }
    case 'hr': return '<hr>\n';
    case 'code': {
      return '<pre><code>' + escapeCode(blk.lines.join('\n') + (blk.lines.length > 0 ? '\n' : '')) + '</code></pre>\n';
    }
    case 'fence': {
      const info = blk.info;
      const rawWord = info.split(/\s+/)[0] || '';
      // backslash escapes are resolved in the info string
      const firstWord = rawWord.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
      const cls = firstWord !== '' ? ' class="language-' + escapeAttr(firstWord) + '"' : '';
      // content lines are joined with \n; a trailing \n is added only when
      // the last content line is not blank
      let content = '';
      if (blk.lines.length > 0) {
        content = blk.lines.join('\n');
        if (blk.lines[blk.lines.length - 1] !== '') content += '\n';
      }
      return '<pre><code' + cls + '>' + escapeCode(content) + '</code></pre>\n';
    }
    case 'html': {
      let text = blk.lines.join('\n');
      // a trailing newline is kept when either its last line is the
      // document's last line and the input ends with a newline, or it
      // ended at its end marker and the next line is not blank
      {
        const lastLineAtEOF = blk.endLine === ctx.totalLines - 1 && ctx.endsNL;
        const nextLine = blk.endLine + 1;
        // the next line counts as "more" when it is non-empty: a line of
        // only spaces/tabs still keeps the trailing newline (marked
        // treats it as a line, not as the absence of one)
        const nextNotBlank = nextLine < ctx.totalLines && ctx.lines[nextLine].length > 0;
        const endedWithMore = blk.endedAtMarker && nextNotBlank;
        if (lastLineAtEOF) text += '\n';
        else if (endedWithMore) text += '\n';
      }
      return text;
    }
    case 'quote': {
      let out = '<blockquote>\n';
      for (const ch of blk.children) out += renderBlock(ch, refs, ctx);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = blk.ordered ? 'ol' : 'ul';
      let out = '<' + tag;
      if (blk.ordered && blk.start !== 1) out += ' start="' + blk.start + '"';
      out += '>\n';
      for (const ch of blk.children) out += renderBlock(ch, refs, ctx);
      return out + '</' + tag + '>\n';
    }
    case 'item': {
      let out = '<li>';
      const kids = blk.children;
      const tight = blk.parent.tight;
      // task list: first paragraph starts with [ ] / [x]
      let task = null;
      if (kids.length > 0 && kids[0].t === 'para') {
        task = taskMarker(kids[0].text);
      }
      for (let a = 0; a < kids.length; a++) {
        const ch = kids[a];
        if (a === 0 && task) {
          const p = ch;
          const text = task.rest;
          if (tight) {
            out += (task.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ') + parseInline(text, refs, ctx);
          } else {
            out += '<p>' + (task.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ') + parseInline(text, refs, ctx) + '</p>\n';
          }
          continue;
        }
        if (ch.t === 'para' && tight) {
          out += parseInline(ch.text, refs, ctx);
        } else {
          out += renderBlock(ch, refs, ctx);
        }
      }
      return out + '</li>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let a = 0; a < blk.header.length; a++) {
        const al = blk.aligns[a];
        out += '<th' + (al ? ' align="' + al + '"' : '') + '>' + parseInline(blk.header[a], refs, ctx) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (blk.rows.length > 0) {
        out += '<tbody>';
        for (const row of blk.rows) {
          out += '<tr>\n';
          for (let a = 0; a < blk.aligns.length; a++) {
            const al = blk.aligns[a];
            const cell = a < row.length ? row[a] : '';
            out += '<td' + (al ? ' align="' + al + '"' : '') + '>' + parseInline(cell, refs, ctx) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default: return '';
  }
}

// ---------------------------------------------------------------- entry point

export function parse(markdown) {
  const { doc, refs, totalLines, endsNL, lines } = parseBlocks(markdown);
  const ctx = { doc, totalLines, endsNL, lines, isTopLevel: true, inA: false };
  return renderBlock(doc, refs, ctx);
}
