import { Box, Text } from "ink";
import { theme } from "../theme.ts";

export type Hint = [key: string, label: string];

export function Footer({ width, hints }: { width: number; hints: Hint[] }) {
  return (
    <Box width={width} height={1} paddingX={1} overflow="hidden">
      <Text wrap="truncate-end">
        {hints.map(([k, l], i) => (
          <Text key={i}>
            <Text color={theme.accent} bold>
              {k}
            </Text>
            <Text color={theme.muted}> {l}</Text>
            {i < hints.length - 1 ? <Text color={theme.faint}>{"  ·  "}</Text> : null}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
