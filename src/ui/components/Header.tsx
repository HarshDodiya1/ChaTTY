import { Box, Text } from "ink";
import type { PresenceStatus } from "../../core/protocol.ts";
import { truncate } from "../text.ts";
import { statusColor, statusGlyph, theme } from "../theme.ts";

export function Header(props: {
  width: number;
  name: string;
  status: PresenceStatus;
  online: number;
  known: number;
  port: number;
  unread: number;
}) {
  const { width, name, status, online, known, port, unread } = props;
  const right = ` ${online}/${known} online  ·  :${port} `;
  return (
    <Box width={width} height={1} backgroundColor={theme.mantle}>
      <Text backgroundColor={theme.accent} color={theme.base} bold>
        {" ◆ ChaTTY "}
      </Text>
      <Text backgroundColor={theme.mantle} color={theme.text}>
        {"  "}
        <Text color={statusColor[status]}>{statusGlyph[status]}</Text> <Text bold>{truncate(name, 20)}</Text>
        <Text color={theme.muted}>{status === "away" ? "  away" : ""}</Text>
        {unread > 0 ? (
          <Text color={theme.peach} bold>
            {"   ✉ "}
            {unread} unread
          </Text>
        ) : null}
      </Text>
      <Box flexGrow={1} />
      <Text backgroundColor={theme.mantle} color={theme.green}>
        {"🔒 E2E "}
      </Text>
      <Text backgroundColor={theme.mantle} color={theme.subtext}>
        {right}
      </Text>
    </Box>
  );
}
