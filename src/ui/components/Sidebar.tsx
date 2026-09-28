import { Box, Text, useAnimation } from "ink";
import type { PresenceStatus } from "../../core/protocol.ts";
import { type Line, padEnd, shortTime, truncate, width as w } from "../text.ts";
import { statusColor, statusGlyph, theme } from "../theme.ts";
import { LineView } from "./LineView.tsx";

export interface SidebarItem {
  convId: string;
  kind: "contact" | "group";
  id: string;
  title: string;
  status: PresenceStatus | null;
  unread: number;
  preview: string | null;
  time: number | null;
  typing: boolean;
  muted: boolean;
  warn: boolean;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Sidebar(props: {
  width: number;
  height: number;
  focused: boolean;
  contacts: SidebarItem[];
  groups: SidebarItem[];
  selected: string | null;
  onlineCount: number;
}) {
  const { width, height, focused, contacts, groups, selected, onlineCount } = props;
  const inner = width - 4;
  const searching = contacts.length === 0;
  const { frame } = useAnimation({
    interval: 90,
    isActive: searching || [...contacts, ...groups].some((i) => i.typing),
  });

  const rows: Array<{ line: Line; fill?: string; sel?: boolean }> = [];
  const section = (title: string, right: string) => {
    rows.push({
      line: [
        { text: title, color: theme.subtext, bold: true },
        { text: " ".repeat(Math.max(1, inner - w(title) - w(right))) },
        { text: right, color: theme.faint },
      ],
    });
  };
  let selectedRow = 0;
  const item = (it: SidebarItem) => {
    const isSel = it.convId === selected;
    if (isSel) selectedRow = rows.length;
    const fill = isSel ? (focused ? theme.surfaceHi : theme.surface) : undefined;
    const marker = isSel ? { text: "▌", color: theme.accent } : { text: " " };
    const glyph =
      it.kind === "group"
        ? { text: "#", color: it.muted ? theme.faint : theme.accent2, bold: true }
        : { text: statusGlyph[it.status ?? "offline"], color: statusColor[it.status ?? "offline"] };
    const badge = it.unread > 0 ? ` ${it.unread > 99 ? "99+" : it.unread} ` : "";
    const time = it.time ? shortTime(it.time) : "";
    const right = badge || time;
    const nameMax = inner - 3 - w(right) - 1;
    const name = truncate(it.title + (it.warn ? " ⚠" : ""), nameMax);
    rows.push({
      fill,
      sel: isSel,
      line: [
        marker,
        glyph,
        { text: " " },
        {
          text: padEnd(name, nameMax),
          bold: it.unread > 0 || isSel,
          color: it.muted ? theme.muted : isSel ? theme.text : undefined,
        },
        { text: " " },
        badge ? { text: badge, bg: theme.accent, color: theme.base, bold: true } : { text: time, color: theme.faint },
      ],
    });
    const sub = it.typing
      ? [{ text: `   ${SPINNER[frame % SPINNER.length]} typing…`, color: theme.green, italic: true }]
      : [
          {
            text: `   ${truncate(it.preview ?? (it.kind === "group" ? "No messages yet" : "Say hello 👋"), inner - 3)}`,
            color: isSel ? theme.subtext : theme.muted,
          },
        ];
    rows.push({ fill, line: sub });
  };

  section("DIRECT MESSAGES", contacts.length ? `${onlineCount}/${contacts.length}` : "");
  if (searching) {
    rows.push({ line: [] });
    rows.push({
      line: [
        { text: ` ${SPINNER[frame % SPINNER.length]} `, color: theme.accent },
        { text: "Looking for peers…", color: theme.subtext },
      ],
    });
    rows.push({ line: [{ text: "   on your local network", color: theme.muted }] });
  } else {
    contacts.forEach(item);
  }
  rows.push({ line: [] });
  section("GROUPS", groups.length ? String(groups.length) : "");
  if (groups.length === 0) {
    rows.push({ line: [{ text: " /group create <name>", color: theme.faint, italic: true }] });
  } else {
    groups.forEach(item);
  }

  // Keep the selection visible.
  const view = height - 2;
  let offset = 0;
  if (rows.length > view) {
    offset = Math.min(Math.max(0, selectedRow - Math.floor(view / 2)), rows.length - view);
  }
  const visible = rows.slice(offset, offset + view);

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
      {visible.map((r, i) => (
        <LineView key={i} line={r.line} width={inner} fill={r.fill} />
      ))}
      {offset + view < rows.length ? (
        <Box position="absolute" bottom={0} right={1}>
          <Text color={theme.faint}>▾ more</Text>
        </Box>
      ) : null}
    </Box>
  );
}
