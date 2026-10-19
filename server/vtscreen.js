// A small terminal screen: feeds it what a program writes to a terminal (text and the common VT/ANSI escape codes)
// and it keeps the screen the user would see, as rows of text. Enough for menus, prompts, progress bars and most
// full-screen terminal programs; colours and styles are dropped. Used by the agent's terminal tool.
export class Screen {
  // onReply: where answers to the program's questions go (the cursor position it asks for with ESC[6n).
  constructor(cols = 100, rows = 30, onReply = null) {
    this.onReply = onReply;
    this.cols = cols; this.rows = rows;
    this.main = this.blank(); this.alt = null;
    this.x = 0; this.y = 0; this.saved = [0, 0];
    this.top = 0; this.bottom = rows - 1;
    this.esc = '';
  }
  blank() { return Array.from({ length: this.rows }, () => Array(this.cols).fill(' ')); }
  get buf() { return this.alt || this.main; }
  scrollUp(n = 1) { for (let i = 0; i < n; i++) { this.buf.splice(this.top, 1); this.buf.splice(this.bottom, 0, Array(this.cols).fill(' ')); } }
  scrollDown(n = 1) { for (let i = 0; i < n; i++) { this.buf.splice(this.bottom, 1); this.buf.splice(this.top, 0, Array(this.cols).fill(' ')); } }
  newline() { if (this.y === this.bottom) this.scrollUp(); else if (this.y < this.rows - 1) this.y++; }
  put(ch) {
    if (this.x >= this.cols) { this.x = 0; this.newline(); }
    this.buf[this.y][this.x++] = ch;
  }
  clamp() { this.x = Math.max(0, Math.min(this.cols - 1, this.x)); this.y = Math.max(0, Math.min(this.rows - 1, this.y)); }
  eraseLine(mode) { const r = this.buf[this.y]; const [a, b] = mode === 1 ? [0, this.x + 1] : mode === 2 ? [0, this.cols] : [this.x, this.cols]; for (let i = a; i < b; i++) r[i] = ' '; }
  eraseScreen(mode) {
    if (mode === 2 || mode === 3) { for (const r of this.buf) r.fill(' '); return; }
    this.eraseLine(mode);
    const rows = mode === 1 ? [0, this.y] : [this.y + 1, this.rows];
    for (let i = rows[0]; i < rows[1]; i++) this.buf[i].fill(' ');
  }
  csi(params, final, priv) {
    const p = params.split(';').map((v) => (v === '' ? null : Number(v)));
    const n = (i, d = 1) => (p[i] == null || Number.isNaN(p[i]) ? d : p[i]);
    switch (final) {
      case 'A': this.y -= n(0); break;
      case 'B': case 'e': this.y += n(0); break;
      case 'C': case 'a': this.x += n(0); break;
      case 'D': this.x -= n(0); break;
      case 'E': this.y += n(0); this.x = 0; break;
      case 'F': this.y -= n(0); this.x = 0; break;
      case 'G': case '`': this.x = n(0) - 1; break;
      case 'd': this.y = n(0) - 1; break;
      case 'H': case 'f': this.y = n(0) - 1; this.x = n(1) - 1; break;
      case 'J': this.eraseScreen(n(0, 0)); break;
      case 'K': this.eraseLine(n(0, 0)); break;
      case 'X': for (let i = 0; i < n(0); i++) if (this.x + i < this.cols) this.buf[this.y][this.x + i] = ' '; break;
      case 'P': { const r = this.buf[this.y]; r.splice(this.x, n(0)); while (r.length < this.cols) r.push(' '); break; }
      case '@': { const r = this.buf[this.y]; r.splice(this.x, 0, ...Array(n(0)).fill(' ')); r.length = this.cols; break; }
      case 'L': { for (let i = 0; i < n(0); i++) { this.buf.splice(this.bottom, 1); this.buf.splice(this.y, 0, Array(this.cols).fill(' ')); } break; }
      case 'M': { for (let i = 0; i < n(0); i++) { this.buf.splice(this.y, 1); this.buf.splice(this.bottom, 0, Array(this.cols).fill(' ')); } break; }
      case 'S': this.scrollUp(n(0)); break;
      case 'T': this.scrollDown(n(0)); break;
      case 'r': this.top = n(0) - 1; this.bottom = (p[1] == null ? this.rows : p[1]) - 1; this.x = 0; this.y = 0; break;
      case 's': this.saved = [this.x, this.y]; break;
      case 'u': [this.x, this.y] = this.saved; break;
      case 'h': case 'l':
        if (priv === '?' && [1049, 47, 1047].includes(n(0))) {
          if (final === 'h') { this.saved = [this.x, this.y]; this.alt = this.blank(); } else { this.alt = null; [this.x, this.y] = this.saved; }
        }
        break;
      case 'n': if (n(0, 0) === 6) this.onReply?.(`\x1b[${this.y + 1};${this.x + 1}R`); else if (n(0, 0) === 5) this.onReply?.('\x1b[0n'); break;
      case 'c': if (!priv) this.onReply?.('\x1b[?1;2c'); break; // "what terminal are you?": a VT100 with options
      default: break; // m (colours), and anything else: ignored
    }
    this.clamp();
  }
  write(data) {
    const s = String(data);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (this.esc) {
        this.esc += ch;
        const e = this.esc;
        if (e.length === 2 && e[1] !== '[' && e[1] !== ']' && e[1] !== '(' && e[1] !== ')') {
          if (e[1] === '7') this.saved = [this.x, this.y]; else if (e[1] === '8') [this.x, this.y] = this.saved;
          else if (e[1] === 'M') { if (this.y === this.top) this.scrollDown(); else this.y--; } else if (e[1] === 'D') this.newline(); else if (e[1] === 'E') { this.x = 0; this.newline(); }
          else if (e[1] === 'c') { this.main = this.blank(); this.alt = null; this.x = this.y = 0; }
          this.esc = ''; continue;
        }
        if (e[1] === '(' || e[1] === ')') { if (e.length === 3) this.esc = ''; continue; }
        if (e[1] === ']') { if (ch === '\x07' || e.endsWith('\x1b\\')) this.esc = ''; continue; } // window title and the like
        if (e[1] === '[' && /[@-~]/.test(ch) && e.length > 2) {
          const body = e.slice(2, -1), priv = /^[?>=!]/.test(body) ? body[0] : '';
          this.csi(priv ? body.slice(1) : body, ch, priv);
          this.esc = '';
        }
        if (this.esc.length > 64) this.esc = '';
        continue;
      }
      if (ch === '\x1b') { this.esc = ch; continue; }
      if (ch === '\r') { this.x = 0; continue; }
      if (ch === '\n') { this.newline(); continue; }
      if (ch === '\b') { this.x = Math.max(0, this.x - 1); continue; }
      if (ch === '\t') { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); continue; }
      if (ch === '\x07' || ch < ' ') continue;
      this.put(ch);
    }
  }
  /** The screen as text: trailing spaces and blank lines at the bottom trimmed; the cursor row marked if asked. */
  text({ cursor = false } = {}) {
    const lines = this.buf.map((r, i) => { const t = r.join('').replace(/\s+$/, ''); return cursor && i === this.y ? `${t}  ◂` : t; });
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }
}
