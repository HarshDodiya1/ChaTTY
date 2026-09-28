import { Box, Text, useAnimation } from "ink";
import { theme } from "../theme.ts";

const LOGO = [
  " ▄████▄  ██   ██   ▄███▄   ████████ ████████ ██    ██",
  "██▀  ▀▀  ██   ██  ██▀ ▀██     ██       ██     ██  ██ ",
  "██       ███████  ███████     ██       ██      ████  ",
  "██▄  ▄▄  ██   ██  ██   ██     ██       ██       ██   ",
  " ▀████▀  ██   ██  ██   ██     ██       ██       ██   ",
];
const GRADIENT = ["#89b4fa", "#98b0f8", "#a8acf5", "#b9a9f3", "#cba6f7"];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Welcome(props: {
  width: number;
  height: number;
  addresses: string[];
  port: number;
  online: number;
  known: number;
  name: string;
}) {
  const { width, height, addresses, port, online, known, name } = props;
  const { frame } = useAnimation({ interval: 90, isActive: online === 0 });
  const bigLogo = width >= 60 && height >= 18;
  const addr = addresses[0] ? `${addresses[0]}:${port}` : `localhost:${port}`;
  return (
    <Box
      width={width}
      height={height}
      borderStyle="round"
      borderColor={theme.border}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
    >
      {bigLogo ? (
        LOGO.map((l, i) => (
          <Text key={i} color={GRADIENT[i]} bold>
            {l}
          </Text>
        ))
      ) : (
        <Text color={theme.accent} bold>
          ◆ ChaTTY
        </Text>
      )}
      <Box height={1} />
      <Text color={theme.subtext}>
        peer-to-peer <Text color={theme.faint}>·</Text> end-to-end encrypted <Text color={theme.faint}>·</Text> no
        servers
      </Text>
      <Box height={1} />
      <Text>
        Welcome,{" "}
        <Text bold color={theme.accent}>
          {name}
        </Text>
      </Text>
      <Box height={1} />
      {online === 0 ? (
        <Text color={theme.yellow}>{SPINNER[frame % SPINNER.length]} Scanning the network for peers…</Text>
      ) : (
        <Text color={theme.green}>
          ● {online} peer{online === 1 ? "" : "s"} online <Text color={theme.muted}>({known} known)</Text>
        </Text>
      )}
      <Text color={theme.muted}>
        Others can reach you at{" "}
        <Text color={theme.teal} bold>
          {addr}
        </Text>
      </Text>
      <Box height={1} />
      <Text color={theme.faint}>
        <Text color={theme.accent}>↑↓</Text> pick a chat <Text color={theme.accent}>Enter</Text> open{" "}
        <Text color={theme.accent}>/</Text> commands <Text color={theme.accent}>?</Text> help
      </Text>
    </Box>
  );
}
