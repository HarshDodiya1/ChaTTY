import { Text } from "ink";
import { clipLine, type Line, lineWidth } from "../text.ts";

/** Render one pre-laid-out line, clipped (and optionally padded) to `width`. */
export function LineView({ line, width, fill }: { line: Line; width: number; fill?: string }) {
  const clipped = clipLine(line, width);
  const pad = fill ? Math.max(0, width - lineWidth(clipped)) : 0;
  return (
    <Text wrap="truncate-end" backgroundColor={fill}>
      {clipped.length === 0 && !fill ? " " : null}
      {clipped.map((s, i) => (
        <Text
          key={i}
          color={s.color}
          backgroundColor={s.bg}
          bold={s.bold}
          dimColor={s.dim}
          italic={s.italic}
          underline={s.underline}
        >
          {s.text}
        </Text>
      ))}
      {pad > 0 ? " ".repeat(pad) : null}
    </Text>
  );
}
