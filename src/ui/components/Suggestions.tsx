import { Box, Text } from "ink";
import type { Suggestion } from "../commands.ts";
import { padEnd, truncate, width as w } from "../text.ts";
import { theme } from "../theme.ts";

export const MAX_SUGGESTIONS = 7;

export function suggestionsHeight(n: number): number {
  return n === 0 ? 0 : Math.min(n, MAX_SUGGESTIONS) + 2;
}

export function Suggestions({ items, selected, width }: { items: Suggestion[]; selected: number; width: number }) {
  if (items.length === 0) return null;
  const inner = width - 4;
  const start = Math.max(0, Math.min(selected - MAX_SUGGESTIONS + 1, items.length - MAX_SUGGESTIONS));
  const shown = items.slice(start, start + MAX_SUGGESTIONS);
  const labelW = Math.min(Math.max(...shown.map((s) => w(s.label))) + 2, Math.floor(inner * 0.55));
  return (
    <Box width={width} flexDirection="column" borderStyle="round" borderColor={theme.peach} paddingX={1}>
      {shown.map((s, i) => {
        const isSel = start + i === selected;
        const bg = isSel ? theme.surfaceHi : undefined;
        const label = padEnd(truncate(s.label, labelW - 1), labelW);
        const detail = padEnd(truncate(s.detail, Math.max(0, inner - labelW - 2)), Math.max(0, inner - labelW - 2));
        return (
          <Text key={s.value + i} backgroundColor={bg} wrap="truncate-end">
            <Text color={isSel ? theme.peach : theme.faint}>{isSel ? "▸ " : "  "}</Text>
            <Text color={isSel ? theme.text : theme.subtext} bold={isSel}>
              {label}
            </Text>
            <Text color={theme.muted}>{detail}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
