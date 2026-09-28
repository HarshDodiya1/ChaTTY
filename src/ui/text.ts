import stringWidth from "string-width";

export interface Seg {
  text: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}
export type Line = Seg[];

export const width = (s: string) => stringWidth(s);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (g) => g.segment);
}

/** Truncate to `max` columns, adding an ellipsis when cut. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const g of graphemes(s)) {
    const gw = width(g);
    if (w + gw > max - 1) break;
    out += g;
    w += gw;
  }
  return `${out}…`;
}

export function padEnd(s: string, cols: number): string {
  const w = width(s);
  return w >= cols ? s : s + " ".repeat(cols - w);
}

export function lineWidth(line: Line): number {
  return line.reduce((n, s) => n + width(s.text), 0);
}

/** Truncate a styled line to `max` columns. */
export function clipLine(line: Line, max: number): Line {
  const out: Line = [];
  let left = max;
  for (const seg of line) {
    if (left <= 0) break;
    const w = width(seg.text);
    if (w <= left) {
      out.push(seg);
      left -= w;
    } else {
      out.push({ ...seg, text: truncate(seg.text, left) });
      left = 0;
    }
  }
  return out;
}

/**
 * Word-wrap styled segments into lines of at most `max` columns. Hard newlines
 * are respected; words longer than a line are broken by grapheme.
 */
export function wrapSegments(segs: Seg[], max: number): Line[] {
  const lines: Line[] = [[]];
  let col = 0;
  const cur = () => lines[lines.length - 1]!;
  const push = (seg: Seg, text: string) => {
    const l = cur();
    const last = l[l.length - 1];
    if (last && sameStyle(last, seg)) last.text += text;
    else l.push({ ...seg, text });
    col += width(text);
  };
  const newline = () => {
    lines.push([]);
    col = 0;
  };
  for (const seg of segs) {
    const parts = seg.text.split("\n");
    parts.forEach((part, pi) => {
      if (pi > 0) newline();
      // tokens: runs of spaces or non-spaces
      for (const tok of part.match(/\s+|\S+/g) ?? []) {
        const tw = width(tok);
        if (/^\s+$/.test(tok)) {
          if (col === 0) continue; // drop leading spaces on wrapped lines
          if (col + tw > max) newline();
          else push(seg, tok);
          continue;
        }
        if (col + tw <= max) {
          push(seg, tok);
          continue;
        }
        if (tw <= max) {
          trimTrailing(cur());
          newline();
          push(seg, tok);
          continue;
        }
        for (const g of graphemes(tok)) {
          const gw = width(g);
          if (col + gw > max) newline();
          push(seg, g);
        }
      }
    });
  }
  for (const l of lines) trimTrailing(l);
  return lines;
}

function trimTrailing(l: Line): void {
  const last = l[l.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, "");
  if (last && last.text === "") l.pop();
}

function sameStyle(a: Seg, b: Seg): boolean {
  return (
    a.color === b.color &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
const MENTION_RE = /(^|\s)(@[\p{L}\p{N}_.-]+)/gu;
const CODE_RE = /`([^`\n]+)`/g;

/** Style a message body: links, `inline code`, @mentions. */
export function richText(body: string, colors: { link: string; code: string; mention: string }): Seg[] {
  type Span = { start: number; end: number; seg: Seg };
  const spans: Span[] = [];
  for (const m of body.matchAll(URL_RE)) {
    spans.push({
      start: m.index!,
      end: m.index! + m[0].length,
      seg: { text: m[0], color: colors.link, underline: true },
    });
  }
  for (const m of body.matchAll(CODE_RE)) {
    spans.push({ start: m.index!, end: m.index! + m[0].length, seg: { text: m[1]!, color: colors.code } });
  }
  for (const m of body.matchAll(MENTION_RE)) {
    const start = m.index! + m[1]!.length;
    spans.push({ start, end: start + m[2]!.length, seg: { text: m[2]!, color: colors.mention, bold: true } });
  }
  spans.sort((a, b) => a.start - b.start);
  const out: Seg[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue; // overlapping
    if (s.start > pos) out.push({ text: body.slice(pos, s.start) });
    out.push(s.seg);
    pos = s.end;
  }
  if (pos < body.length) out.push({ text: body.slice(pos) });
  return out;
}

// ── time ──────────────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Label for a day separator: Today, Yesterday, Monday, or "Mar 3, 2026". */
export function dayLabel(ts: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const d = new Date(ts);
  if (diff < 7) return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]!;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Compact time for lists: 14:02, Mon, Mar 3. */
export function shortTime(ts: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (diff === 0) return clock(ts);
  const d = new Date(ts);
  if (diff < 7) return DAYS[d.getDay()]!;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function progressBar(fraction: number, cols: number): { done: string; rest: string } {
  const f = Math.max(0, Math.min(1, fraction));
  const exact = f * cols;
  const full = Math.floor(exact);
  const partials = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const part = partials[Math.floor((exact - full) * 8)] ?? "";
  const done = "█".repeat(full) + part;
  return { done, rest: "─".repeat(Math.max(0, cols - full - (part ? 1 : 0))) };
}
