import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { padEnd, truncate, width as w } from "../text.ts";
import { theme } from "../theme.ts";

/** Centered floating panel with an opaque background. */
export function Modal(props: {
  screenWidth: number;
  screenHeight: number;
  width: number;
  height: number;
  title: string;
  color?: string;
  footer?: string;
  children: ReactNode;
}) {
  const { screenWidth, screenHeight, title, footer, children } = props;
  const width = Math.min(props.width, screenWidth - 2);
  const height = Math.min(props.height, screenHeight - 2);
  const color = props.color ?? theme.accent;
  const inner = width - 4;
  return (
    <Box
      position="absolute"
      top={Math.max(0, Math.floor((screenHeight - height) / 2))}
      left={Math.max(0, Math.floor((screenWidth - width) / 2))}
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      backgroundColor={theme.base}
      paddingX={1}
    >
      <Text backgroundColor={theme.base} color={color} bold>
        {padEnd(truncate(title, inner), inner)}
      </Text>
      <Text backgroundColor={theme.base} color={theme.faint}>
        {"─".repeat(inner)}
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {children}
      </Box>
      {footer ? (
        <Text backgroundColor={theme.base} color={theme.muted}>
          {padEnd(truncate(footer, inner), inner)}
        </Text>
      ) : null}
    </Box>
  );
}

export interface ListRow {
  key: string;
  left: string;
  right?: string;
  color?: string;
  rightColor?: string;
  sub?: string;
}

/** Scrollable list for use inside a Modal. */
export function ModalList({
  rows,
  selected,
  width,
  height,
  empty,
}: {
  rows: ListRow[];
  selected: number;
  width: number;
  height: number;
  empty?: string;
}) {
  const inner = width - 4;
  if (rows.length === 0) {
    return (
      <Text backgroundColor={theme.base} color={theme.muted}>
        {padEnd(empty ?? "Nothing here yet.", inner)}
      </Text>
    );
  }
  const perRow = rows.some((r) => r.sub) ? 2 : 1;
  const fit = Math.max(1, Math.floor(height / perRow));
  const start = Math.max(0, Math.min(selected - Math.floor(fit / 2), rows.length - fit));
  return (
    <>
      {rows.slice(start, start + fit).map((r, i) => {
        const isSel = start + i === selected;
        const bg = isSel ? theme.surfaceHi : theme.base;
        const right = r.right ?? "";
        const leftMax = inner - 2 - w(right) - 1;
        return (
          <Box key={r.key} flexDirection="column">
            <Text backgroundColor={bg}>
              <Text color={isSel ? theme.accent : theme.faint}>{isSel ? "▸ " : "  "}</Text>
              <Text color={r.color ?? theme.text} bold={isSel}>
                {padEnd(truncate(r.left, leftMax), leftMax)}
              </Text>
              <Text> </Text>
              <Text color={r.rightColor ?? theme.muted}>{right}</Text>
            </Text>
            {r.sub !== undefined ? (
              <Text backgroundColor={bg} color={theme.muted}>
                {padEnd(`  ${truncate(r.sub, inner - 2)}`, inner)}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </>
  );
}
