import { Box, Text } from "ink";
import type { Notice } from "../../core/engine.ts";
import { padEnd, truncate, wrapSegments } from "../text.ts";
import { noticeColor, noticeGlyph, theme } from "../theme.ts";

export interface Toast extends Notice {
  id: number;
}

export function Toasts({ toasts, screenWidth }: { toasts: Toast[]; screenWidth: number }) {
  if (toasts.length === 0) return null;
  const width = Math.min(46, screenWidth - 4);
  const inner = width - 4;
  return (
    <Box position="absolute" top={1} right={1} flexDirection="column" width={width}>
      {toasts.slice(-3).map((t) => {
        const color = noticeColor[t.level];
        const body = wrapSegments([{ text: t.text }], inner).slice(0, 3);
        return (
          <Box
            key={t.id}
            flexDirection="column"
            borderStyle="round"
            borderColor={color}
            backgroundColor={theme.base}
            paddingX={1}
            width={width}
          >
            <Text backgroundColor={theme.base} color={color} bold>
              {padEnd(`${t.icon ?? noticeGlyph[t.level]} ${truncate(t.title, inner - 2)}`, inner)}
            </Text>
            {body.map((l, i) => (
              <Text key={i} backgroundColor={theme.base} color={theme.text}>
                {padEnd(l.map((s) => s.text).join(""), inner)}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
