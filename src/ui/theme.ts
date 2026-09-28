// Catppuccin-Mocha-inspired palette. Body text keeps the terminal's default
// foreground so the app stays readable on light themes too; explicit colors
// are used for accents and anywhere we paint a background.

export const theme = {
  accent: "#89b4fa",
  accent2: "#cba6f7",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  red: "#f38ba8",
  peach: "#fab387",
  teal: "#94e2d5",
  sky: "#89dceb",
  pink: "#f5c2e7",
  text: "#cdd6f4",
  subtext: "#a6adc8",
  muted: "#7f849c",
  faint: "#585b70",
  surface: "#313244",
  surfaceHi: "#45475a",
  base: "#1e1e2e",
  mantle: "#181825",
  border: "#45475a",
  borderFocus: "#89b4fa",
} as const;

const NAME_COLORS = [
  "#f5c2e7",
  "#fab387",
  "#f9e2af",
  "#a6e3a1",
  "#94e2d5",
  "#89dceb",
  "#74c7ec",
  "#b4befe",
  "#cba6f7",
  "#eba0ac",
];

/** Stable per-user color. */
export function nameColor(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return NAME_COLORS[Math.abs(h) % NAME_COLORS.length]!;
}

export const statusGlyph = { online: "●", away: "◐", offline: "○" } as const;
export const statusColor = { online: theme.green, away: theme.yellow, offline: theme.faint } as const;

export const noticeColor = {
  info: theme.accent,
  success: theme.green,
  warn: theme.yellow,
  error: theme.red,
} as const;

export const noticeGlyph = { info: "ℹ", success: "✔", warn: "⚠", error: "✖" } as const;
