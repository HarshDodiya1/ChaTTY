import { Box, Text } from "ink";
import { graphemes, width as w } from "../text.ts";
import { theme } from "../theme.ts";

export const MAX_COMPOSER_LINES = 5;

/** Char-wrap the input into rows and locate the cursor. */
export function layoutInput(value: string, cursor: number, cols: number) {
  const gs = graphemes(value);
  const rows: string[][] = [[]];
  let col = 0;
  let cur = { row: 0, col: 0 };
  gs.forEach((g, i) => {
    if (i === cursor) cur = { row: rows.length - 1, col: rows[rows.length - 1]!.length };
    if (g === "\n") {
      rows.push([]);
      col = 0;
      return;
    }
    const gw = w(g);
    if (col + gw > cols) {
      rows.push([]);
      col = 0;
    }
    rows[rows.length - 1]!.push(g);
    col += gw;
  });
  if (cursor >= gs.length) {
    const last = rows[rows.length - 1]!;
    const lastW = last.reduce((n, g) => n + w(g), 0);
    if (lastW >= cols) {
      rows.push([]);
      cur = { row: rows.length - 1, col: 0 };
    } else {
      cur = { row: rows.length - 1, col: last.length };
    }
  }
  return { rows, cur };
}

export function composerHeight(value: string, cursor: number, cols: number): number {
  return Math.min(MAX_COMPOSER_LINES, layoutInput(value, cursor, cols).rows.length) + 2;
}

export function Composer(props: {
  width: number;
  value: string;
  cursor: number;
  focused: boolean;
  placeholder: string;
  disabled?: boolean;
  hint?: string;
}) {
  const { width, value, cursor, focused, placeholder, disabled, hint } = props;
  const cols = width - 6;
  const isCommand = value.startsWith("/");
  const prompt = isCommand ? "⌘ " : "❯ ";
  const promptColor = isCommand ? theme.peach : focused ? theme.accent : theme.faint;
  const { rows, cur } = layoutInput(value, cursor, cols);
  const first = Math.max(0, Math.min(cur.row - MAX_COMPOSER_LINES + 1, rows.length - MAX_COMPOSER_LINES));
  const shown = rows.slice(first, first + MAX_COMPOSER_LINES);

  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle="round"
      borderColor={disabled ? theme.border : focused ? (isCommand ? theme.peach : theme.borderFocus) : theme.border}
      paddingX={1}
    >
      {value.length === 0 ? (
        <Text wrap="truncate-end">
          <Text color={promptColor} bold>
            {prompt}
          </Text>
          {focused ? <Text inverse> </Text> : null}
          <Text color={theme.faint}>{placeholder}</Text>
        </Text>
      ) : (
        shown.map((row, ri) => {
          const r = ri + first;
          const isCur = focused && r === cur.row;
          const before = isCur ? row.slice(0, cur.col).join("") : row.join("");
          const at = isCur ? (row[cur.col] ?? " ") : "";
          const after = isCur ? row.slice(cur.col + 1).join("") : "";
          return (
            <Text key={r} wrap="truncate-end">
              <Text color={promptColor} bold>
                {r === 0 ? prompt : "  "}
              </Text>
              <Text color={isCommand ? theme.peach : undefined}>{before}</Text>
              {isCur ? <Text inverse>{at}</Text> : null}
              <Text color={isCommand ? theme.peach : undefined}>{after}</Text>
            </Text>
          );
        })
      )}
      {hint ? (
        <Box position="absolute" top={-1} right={1}>
          <Text color={theme.faint}> {hint} </Text>
        </Box>
      ) : null}
    </Box>
  );
}
