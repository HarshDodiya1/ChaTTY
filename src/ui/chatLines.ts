import os from "node:os";
import { formatBytes, type MessageView, type TransferView } from "../core/engine.ts";
import {
  clock,
  dayLabel,
  type Line,
  progressBar,
  richText,
  type Seg,
  sameDay,
  truncate,
  width,
  wrapSegments,
} from "./text.ts";
import { nameColor, theme } from "./theme.ts";

export interface ChatLines {
  lines: Line[];
  /** Message id owning each line (null for separators). */
  owners: Array<string | null>;
}

const GROUP_GAP_MS = 5 * 60_000;
const BAR = "▎";

const tick = (status: MessageView["status"]): Seg | null => {
  switch (status) {
    case "sent":
      return { text: "✓", color: theme.muted };
    case "delivered":
      return { text: "✓✓", color: theme.muted };
    case "read":
      return { text: "✓✓", color: theme.accent };
    default:
      return null;
  }
};

const tildify = (p: string) => {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

function transferLines(t: TransferView, cols: number): Line[] {
  const head: Line = [
    { text: "📎 ", color: theme.peach },
    { text: truncate(t.name, Math.max(8, cols - 16)), bold: true },
    { text: `  ${formatBytes(t.size)}`, color: theme.muted },
  ];
  const incoming = t.direction === "in";
  let status: Line;
  switch (t.status) {
    case "offered":
      status = incoming
        ? [
            { text: "⏳ Incoming file — ", color: theme.yellow },
            { text: "/accept", color: theme.green, bold: true },
            { text: " or ", color: theme.muted },
            { text: "/decline", color: theme.red, bold: true },
          ]
        : [{ text: `⏳ Waiting for ${t.peerLabel} to accept…`, color: theme.yellow }];
      break;
    case "accepted":
    case "in_progress": {
      const frac = t.size === 0 ? 1 : t.bytes / t.size;
      const barCols = Math.max(10, Math.min(30, cols - 26));
      const bar = progressBar(frac, barCols);
      status = [
        { text: bar.done, color: theme.accent },
        { text: bar.rest, color: theme.faint },
        { text: ` ${String(Math.floor(frac * 100)).padStart(3)}%`, bold: true },
        { text: `  ${incoming ? "receiving" : "sending"}`, color: theme.muted },
      ];
      break;
    }
    case "complete":
      status = incoming
        ? [
            { text: "✔ Saved to ", color: theme.green },
            { text: tildify(t.path ?? ""), color: theme.teal },
          ]
        : [{ text: `✔ Delivered to ${t.peerLabel}`, color: theme.green }];
      break;
    case "declined":
      status = [{ text: incoming ? "✖ You declined this file" : `✖ ${t.peerLabel} declined`, color: theme.red }];
      break;
    case "cancelled":
      status = [{ text: `✖ Cancelled${t.error ? ` — ${t.error}` : ""}`, color: theme.red }];
      break;
    default:
      status = [{ text: `✖ Failed${t.error ? ` — ${t.error}` : ""}`, color: theme.red }];
  }
  return [head, status];
}

/** Lay out messages for a pane `cols` wide. */
export function buildChatLines(messages: MessageView[], cols: number, now = Date.now()): ChatLines {
  const lines: Line[] = [];
  const owners: Array<string | null> = [];
  const push = (l: Line, owner: string | null) => {
    lines.push(l);
    owners.push(owner);
  };
  const center = (text: string, seg: Omit<Seg, "text">): Line => {
    const t = truncate(text, cols);
    const padL = Math.max(0, Math.floor((cols - width(t)) / 2));
    return [{ text: " ".repeat(padL) }, { ...seg, text: t }];
  };

  let prev: MessageView | null = null;
  const bodyCols = Math.max(10, cols - 6);

  for (const m of messages) {
    if (!prev || !sameDay(prev.ts, m.ts)) {
      if (lines.length) push([], null);
      const label = ` ${dayLabel(m.ts, now)} `;
      const side = Math.max(2, Math.floor((cols - width(label)) / 2));
      push(
        [
          { text: "─".repeat(side), color: theme.faint },
          { text: label, color: theme.subtext, bold: true },
          { text: "─".repeat(Math.max(0, cols - side - width(label))), color: theme.faint },
        ],
        null,
      );
      prev = null;
    }

    if (m.kind === "system") {
      push([], null);
      push(center(`· ${m.body} ·`, { color: theme.muted, italic: true }), m.id);
      prev = m;
      continue;
    }

    const newGroup = !prev || prev.kind === "system" || prev.senderId !== m.senderId || m.ts - prev.ts > GROUP_GAP_MS;
    const color = m.fromMe ? theme.accent : nameColor(m.senderId);
    if (newGroup) {
      push([], null);
      push(
        [
          { text: " " },
          { text: m.fromMe ? "You" : m.senderLabel, color, bold: true },
          { text: `  ${clock(m.ts)}`, color: theme.faint },
        ],
        m.id,
      );
    }

    let body: Line[];
    if (m.kind === "file" && m.transfer) {
      body = transferLines(m.transfer, bodyCols);
    } else {
      body = wrapSegments(richText(m.body, { link: theme.sky, code: theme.peach, mention: theme.yellow }), bodyCols);
    }
    if (body.length === 0) body = [[]];

    body.forEach((l, i) => {
      const line: Line = [{ text: " " }, { text: BAR, color }, { text: " " }, ...l];
      const t = i === body.length - 1 ? tick(m.status) : null;
      if (t) {
        const used = 3 + l.reduce((n, s) => n + width(s.text), 0);
        const gap = Math.max(1, cols - used - width(t.text));
        line.push({ text: " ".repeat(gap) }, t);
      }
      push(line, m.id);
    });
    prev = m;
  }
  return { lines, owners };
}
