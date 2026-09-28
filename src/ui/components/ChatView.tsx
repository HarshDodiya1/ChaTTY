import { Box, Text, useAnimation } from "ink";
import type { ConversationInfo } from "../../core/engine.ts";
import { ago, type Line, truncate, width as w } from "../text.ts";
import { statusColor, statusGlyph, theme } from "../theme.ts";
import { LineView } from "./LineView.tsx";

const DOTS = ["·  ", "·· ", "···", " ··", "  ·", "   "];

export function ChatView(props: {
  width: number;
  height: number;
  focused: boolean;
  info: ConversationInfo;
  lines: Line[];
  scroll: number;
  typing: string[];
  highlight?: string | null;
  owners: Array<string | null>;
}) {
  const { width, height, focused, info, lines, scroll, typing, highlight, owners } = props;
  const inner = width - 4;
  const bodyH = Math.max(1, height - 2 - 3);
  const { frame } = useAnimation({ interval: 160, isActive: typing.length > 0 });

  const end = Math.max(0, lines.length - scroll);
  const start = Math.max(0, end - bodyH);
  const visible = lines.slice(start, end);
  const padTop = bodyH - visible.length;

  // ── title bar ──
  let subtitle: Line;
  if (info.type === "direct" && info.peer) {
    const p = info.peer;
    subtitle =
      p.status === "offline"
        ? [
            { text: `${statusGlyph.offline} `, color: statusColor.offline },
            { text: `offline · last seen ${ago(p.lastSeen)}`, color: theme.muted },
          ]
        : [
            { text: `${statusGlyph[p.status]} `, color: statusColor[p.status] },
            { text: p.status === "away" ? "away" : "online", color: statusColor[p.status] },
          ];
  } else if (info.group) {
    const online = info.group.members.filter((m) => !m.isMe && m.status !== "offline").length;
    subtitle = [
      { text: `${info.group.members.length} members`, color: theme.subtext },
      { text: " · ", color: theme.faint },
      { text: `${online} online`, color: online ? theme.green : theme.muted },
      ...(info.group.left ? [{ text: " · you left", color: theme.red }] : []),
    ];
  } else {
    subtitle = [];
  }
  const lockFull: Line = info.encrypted
    ? [{ text: "🔒 end-to-end encrypted", color: theme.green }]
    : info.type === "direct"
      ? [{ text: "✉ queued until online", color: theme.muted }]
      : [{ text: "", color: theme.muted }];
  const titleText = info.type === "group" ? `# ${info.title}` : info.title;
  const titleLine: Line = [
    {
      text: truncate(titleText, Math.max(8, inner - 40)),
      bold: true,
      color: info.type === "group" ? theme.accent2 : theme.text,
    },
    { text: "  " },
    ...subtitle,
  ];
  const tw = titleLine.reduce((n, s) => n + w(s.text), 0);
  const fullW = lockFull.reduce((n, s) => n + w(s.text), 0);
  const lock: Line = tw + fullW + 2 <= inner ? lockFull : info.encrypted ? [{ text: "🔒", color: theme.green }] : [];
  const lw = lock.reduce((n, s) => n + w(s.text), 0);
  const title: Line = tw + lw + 2 <= inner ? [...titleLine, { text: " ".repeat(inner - tw - lw) }, ...lock] : titleLine;

  // ── status row ──
  let status: Line = [];
  if (typing.length) {
    const who =
      typing.length === 1
        ? typing[0]!
        : typing.length === 2
          ? `${typing[0]} and ${typing[1]}`
          : `${typing.length} people`;
    status = [
      { text: ` ${DOTS[frame % DOTS.length]} `, color: theme.green, bold: true },
      { text: `${who} ${typing.length === 1 ? "is" : "are"} typing`, color: theme.subtext, italic: true },
    ];
  }
  if (scroll > 0) {
    const more: Line = [
      { text: ` ↓ ${scroll} more line${scroll === 1 ? "" : "s"} · End to jump `, color: theme.base, bg: theme.yellow },
    ];
    const used = status.reduce((n, s) => n + w(s.text), 0);
    const mw = more.reduce((n, s) => n + w(s.text), 0);
    status = [...status, { text: " ".repeat(Math.max(1, inner - used - mw)) }, ...more];
  }

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.borderFocus : theme.border}
      paddingX={1}
      overflow="hidden"
    >
      <LineView line={title} width={inner} />
      <Text color={theme.faint}>{"─".repeat(inner)}</Text>
      {lines.length === 0 ? (
        <Box height={bodyH} flexDirection="column" alignItems="center" justifyContent="center">
          <Text color={theme.faint}>╭────────────────────────────────────╮</Text>
          <Text color={theme.subtext}>{centerIn(`No messages yet with ${truncate(info.title, 18)}`, 36)}</Text>
          <Text color={theme.muted}>{centerIn("Type below and press Enter 👋", 35)}</Text>
          <Text color={theme.faint}>╰────────────────────────────────────╯</Text>
        </Box>
      ) : padTop > 0 ? (
        <Box height={padTop} />
      ) : null}
      {visible.map((l, i) => {
        const owner = owners[start + i];
        return (
          <LineView
            key={start + i}
            line={l}
            width={inner}
            fill={highlight && owner === highlight ? theme.surface : undefined}
          />
        );
      })}
      <LineView line={status} width={inner} />
    </Box>
  );
}

function centerIn(text: string, cols: number): string {
  const t = truncate(text, cols - 2);
  const left = Math.max(0, Math.floor((cols - w(t)) / 2));
  return ` ${" ".repeat(left)}${t}${" ".repeat(Math.max(0, cols - left - w(t)))} `;
}
