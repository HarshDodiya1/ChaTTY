import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ArgKind = "user" | "users" | "file" | "status" | "toggle" | "transfer" | "text" | "number";

export interface CommandSpec {
  name: string;
  aliases?: string[];
  args: ArgKind[];
  usage: string;
  description: string;
  section: "General" | "Chat" | "Groups" | "Files" | "Security";
  key?: string;
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "help",
    aliases: ["?"],
    args: [],
    usage: "/help",
    description: "Show commands and shortcuts",
    section: "General",
    key: "F1",
  },
  {
    name: "info",
    args: [],
    usage: "/info",
    description: "Your name, address, port and fingerprint",
    section: "General",
  },
  { name: "nick", args: ["text"], usage: "/nick <name>", description: "Change your display name", section: "General" },
  {
    name: "status",
    args: ["status"],
    usage: "/status <online|away>",
    description: "Set your availability",
    section: "General",
  },
  {
    name: "connect",
    args: ["text"],
    usage: "/connect <host[:port]>",
    description: "Connect to a peer manually",
    section: "General",
  },
  { name: "peers", args: [], usage: "/peers", description: "List known peers", section: "General" },
  {
    name: "notify",
    args: ["toggle"],
    usage: "/notify <on|off>",
    description: "Desktop notifications",
    section: "General",
  },
  {
    name: "quit",
    aliases: ["q", "exit"],
    args: [],
    usage: "/quit",
    description: "Exit ChaTTY",
    section: "General",
    key: "Ctrl+C",
  },

  {
    name: "msg",
    aliases: ["dm"],
    args: ["user"],
    usage: "/msg <user>",
    description: "Open a direct conversation",
    section: "Chat",
  },
  {
    name: "search",
    args: ["text"],
    usage: "/search <text>",
    description: "Search this conversation",
    section: "Chat",
    key: "Ctrl+F",
  },
  {
    name: "history",
    args: ["number"],
    usage: "/history [n]",
    description: "Load the last n messages (default 500)",
    section: "Chat",
  },
  { name: "clear", args: [], usage: "/clear", description: "Clear the view (history is kept)", section: "Chat" },
  { name: "export", args: [], usage: "/export", description: "Save this conversation to a text file", section: "Chat" },

  {
    name: "group create",
    args: ["text", "users"],
    usage: "/group create <name> [users…]",
    description: "Create a group",
    section: "Groups",
  },
  {
    name: "group invite",
    args: ["user"],
    usage: "/group invite <user>",
    description: "Add someone to this group",
    section: "Groups",
  },
  {
    name: "group members",
    args: [],
    usage: "/group members",
    description: "Show members of this group",
    section: "Groups",
  },
  { name: "group leave", args: [], usage: "/group leave", description: "Leave this group", section: "Groups" },
  { name: "group list", args: [], usage: "/group list", description: "List your groups", section: "Groups" },

  {
    name: "file",
    aliases: ["send"],
    args: ["file"],
    usage: "/file <path>",
    description: "Send a file to this peer",
    section: "Files",
  },
  {
    name: "files",
    aliases: ["transfers"],
    args: [],
    usage: "/files",
    description: "Show file transfers",
    section: "Files",
    key: "Ctrl+T",
  },
  {
    name: "accept",
    args: ["transfer"],
    usage: "/accept [file]",
    description: "Accept an incoming file",
    section: "Files",
  },
  {
    name: "decline",
    args: ["transfer"],
    usage: "/decline [file]",
    description: "Decline an incoming file",
    section: "Files",
  },
  { name: "cancel", args: ["transfer"], usage: "/cancel [file]", description: "Cancel a transfer", section: "Files" },
  {
    name: "autoaccept",
    args: ["toggle"],
    usage: "/autoaccept <on|off>",
    description: "Accept incoming files automatically",
    section: "Files",
  },

  {
    name: "verify",
    args: ["user"],
    usage: "/verify [user]",
    description: "Compare safety numbers with a peer",
    section: "Security",
  },
];

export interface ParsedCommand {
  spec: CommandSpec;
  args: string[];
  rest: string;
}

/** Resolve "/group invite bob" → spec "group invite" + args ["bob"]. */
export function parseCommand(input: string): ParsedCommand | { error: string } | null {
  if (!input.startsWith("/")) return null;
  const body = input.slice(1).trim();
  if (!body) return { error: "Type a command, e.g. /help" };
  const words = body.split(/\s+/);
  const first = words[0]!.toLowerCase();
  if (first === "group") {
    const sub = (words[1] ?? "").toLowerCase();
    const spec = COMMANDS.find((c) => c.name === `group ${sub}`);
    if (!spec) return { error: "Usage: /group create|invite|members|leave|list" };
    const rest = body.replace(/^\S+\s+\S+\s*/, "");
    return { spec, args: words.slice(2), rest };
  }
  const spec = COMMANDS.find((c) => c.name === first || c.aliases?.includes(first));
  if (!spec) return { error: `Unknown command /${first} — try /help` };
  return { spec, args: words.slice(1), rest: body.replace(/^\S+\s*/, "") };
}

export interface Suggestion {
  label: string;
  detail: string;
  /** Full input value after accepting the suggestion. */
  value: string;
}

export interface CompletionContext {
  users: Array<{ label: string; status: string }>;
  transfers: Array<{ id: string; name: string; detail: string }>;
  cwd?: string;
}

export function suggestions(input: string, ctx: CompletionContext): Suggestion[] {
  if (!input.startsWith("/")) return [];
  const body = input.slice(1);
  const hasSpace = /\s/.test(body);

  // Still typing the command name.
  if (!hasSpace || /^group\s+\S*$/i.test(body)) {
    const q = body.toLowerCase().replace(/\s+/g, " ");
    return COMMANDS.filter((c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q) && q.length > 0))
      .filter((c) => !(q === "" && c.name.startsWith("group ") && c.name !== "group create"))
      .map((c) => ({ label: c.usage, detail: c.description, value: `/${c.name}${c.args.length ? " " : ""}` }));
  }

  const parsed = parseCommand(input);
  if (!parsed || "error" in parsed) return [];
  const { spec } = parsed;
  const prefixLen = input.length - (input.match(/(\S*)$/)?.[1]?.length ?? 0);
  const head = input.slice(0, prefixLen);
  const token = input.slice(prefixLen);
  const argIndex = parsed.args.length - (token ? 1 : 0);
  const kind = spec.args[Math.min(argIndex, spec.args.length - 1)];
  if (spec.args.length === 0 || (argIndex >= spec.args.length && kind !== "users")) return [];

  switch (kind) {
    case "user":
    case "users": {
      const q = token.replace(/^@/, "").toLowerCase();
      // Extra names in a list are optional: only suggest once the user starts typing one.
      if (kind === "users" && !q) return [];
      const used = new Set(parsed.args.slice(0, argIndex).map((a) => a.replace(/^@/, "").toLowerCase()));
      return ctx.users
        .filter((u) => !used.has(u.label.toLowerCase()))
        .filter((u) => u.label.toLowerCase().startsWith(q))
        .filter((u) => !(q && u.label.toLowerCase() === q && kind === "users"))
        .slice(0, 8)
        .map((u) => ({ label: u.label, detail: u.status, value: `${head}${u.label} ` }));
    }
    case "status":
      return ["online", "away"]
        .filter((s) => s.startsWith(token.toLowerCase()))
        .map((s) => ({ label: s, detail: s === "online" ? "Available" : "Show as away", value: `${head}${s}` }));
    case "toggle":
      return ["on", "off"]
        .filter((s) => s.startsWith(token))
        .map((s) => ({ label: s, detail: "", value: `${head}${s}` }));
    case "transfer":
      return ctx.transfers
        .filter((t) => t.name.toLowerCase().startsWith(token.toLowerCase()) || t.id.startsWith(token))
        .slice(0, 8)
        .map((t) => ({ label: t.name, detail: t.detail, value: `${head}${t.id.slice(0, 8)}` }));
    case "file":
      return fileSuggestions(parsed.rest, input.slice(0, input.length - parsed.rest.length), ctx.cwd ?? process.cwd());
    default:
      return [];
  }
}

function fileSuggestions(partial: string, head: string, cwd: string): Suggestion[] {
  const expanded = partial.replace(/^~(?=$|\/)/, os.homedir());
  const dirPart = expanded.endsWith("/") ? expanded : path.dirname(expanded);
  const base = expanded.endsWith("/") ? "" : path.basename(expanded);
  const dir = path.resolve(cwd, dirPart || ".");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const shownDir = partial.endsWith("/")
    ? partial
    : partial.includes("/")
      ? partial.slice(0, partial.lastIndexOf("/") + 1)
      : "";
  return entries
    .filter((e) => e.name.startsWith(base) && (base.startsWith(".") || !e.name.startsWith(".")))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((e) => {
      const isDir = e.isDirectory();
      let detail = isDir ? "folder" : "";
      if (!isDir) {
        try {
          detail = humanSize(fs.statSync(path.join(dir, e.name)).size);
        } catch {}
      }
      return { label: e.name + (isDir ? "/" : ""), detail, value: `${head}${shownDir}${e.name}${isDir ? "/" : ""}` };
    });
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
