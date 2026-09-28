import fs from "node:fs";
import path from "node:path";
import { Box, type Key, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ChatEngine, formatBytes, type MessageView, type Notice, type TransferView } from "../core/engine.ts";
import { desktopNotify } from "../util/notify.ts";
import { buildChatLines } from "./chatLines.ts";
import { COMMANDS, type CommandSpec, suggestions as computeSuggestions, parseCommand } from "./commands.ts";
import { ChatView } from "./components/ChatView.tsx";
import { Composer, composerHeight } from "./components/Composer.tsx";
import { Footer, type Hint } from "./components/Footer.tsx";
import { Header } from "./components/Header.tsx";
import { type ListRow, Modal, ModalList } from "./components/Modal.tsx";
import { Sidebar, type SidebarItem } from "./components/Sidebar.tsx";
import { Suggestions, suggestionsHeight } from "./components/Suggestions.tsx";
import { type Toast, Toasts } from "./components/Toasts.tsx";
import { Welcome } from "./components/Welcome.tsx";
import { ago, clock, graphemes, padEnd, shortTime, width as strWidth, truncate, wrapSegments } from "./text.ts";
import { statusColor, statusGlyph, theme } from "./theme.ts";

type Focus = "sidebar" | "input";

type Overlay =
  | { type: "help"; scroll: number }
  | { type: "search"; query: string; results: MessageView[]; sel: number }
  | { type: "transfers"; sel: number }
  | { type: "info" }
  | { type: "verify"; peerId: string }
  | { type: "peers"; sel: number }
  | { type: "groups"; sel: number }
  | { type: "members" }
  | { type: "offer"; transferId: string };

const DEFAULT_LIMIT = 300;

function useEngineVersion(engine: ChatEngine): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const on = () => setV((x) => x + 1);
    engine.on("change", on);
    return () => {
      engine.off("change", on);
    };
  }, [engine]);
  return v;
}

export interface AppProps {
  engine: ChatEngine;
  onQuit: () => Promise<void>;
  startupNotices?: Notice[];
}

export function App({ engine, onQuit, startupNotices }: AppProps) {
  const { exit } = useApp();
  const { columns: cols, rows } = useWindowSize();
  const version = useEngineVersion(engine);

  const [focus, setFocusState] = useState<Focus>("sidebar");
  const focusRef = useRef<Focus>(focus);
  const setFocus = (f: Focus) => {
    focusRef.current = f;
    setFocusState(f);
  };
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [input, setInputState] = useState({ value: "", cursor: 0 });
  // Key events can arrive faster than React re-renders (paste + Enter); handlers
  // read and write the input through this ref so no keystroke sees stale state.
  const inputRef = useRef(input);
  const setInput = (next: { value: string; cursor: number }) => {
    inputRef.current = next;
    setInputState(next);
  };
  const [sugIndex, setSugIndex] = useState(0);
  const [sugDismissed, setSugDismissed] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [scroll, setScroll] = useState(0);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [clearedAt, setClearedAt] = useState<Record<string, number>>({});
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [offerQueue, setOfferQueue] = useState<string[]>([]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [quitting, setQuitting] = useState(false);
  const toastId = useRef(0);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeConv;

  // ── notices & events ──────────────────────────────────────────────────

  const toast = useCallback((n: Notice, ms = 3500) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-4), { ...n, id }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: startup notices are shown once, on mount
  useEffect(() => {
    for (const n of startupNotices ?? []) toast(n, 6000);
    const onNotice = (n: Notice) => {
      // Presence toasts would be noisy for the conversation you're looking at.
      toast(n, n.level === "error" || n.level === "warn" ? 6000 : 3500);
    };
    const onIncoming = (m: {
      convId: string;
      senderLabel: string;
      body: string;
      isGroup: boolean;
      groupName?: string;
    }) => {
      if (m.convId === activeRef.current && engine.me.status !== "away") return;
      const title = m.isGroup ? `${m.senderLabel} in #${m.groupName}` : m.senderLabel;
      toast({ level: "info", icon: "✉", title, text: m.body });
      if (engine.config.notifications) desktopNotify(`ChaTTY — ${title}`, m.body);
    };
    const onOffer = (t: TransferView) => setOfferQueue((q) => [...q, t.id]);
    engine.on("notice", onNotice);
    engine.on("incoming", onIncoming);
    engine.on("file_offer", onOffer);
    return () => {
      engine.off("notice", onNotice);
      engine.off("incoming", onIncoming);
      engine.off("file_offer", onOffer);
    };
  }, [engine, toast]);

  // Show queued file offers one at a time.
  useEffect(() => {
    if (overlay || offerQueue.length === 0) return;
    const [next, ...rest] = offerQueue;
    setOfferQueue(rest);
    const t = engine.store.getTransfer(next!);
    if (t && t.status === "offered") setOverlay({ type: "offer", transferId: next! });
  }, [overlay, offerQueue, engine]);

  // ── data ──────────────────────────────────────────────────────────────

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` bumps on every engine change; it is the cache key
  const data = useMemo(() => {
    const contacts = engine.contacts();
    const groups = engine.groups();
    const typingByConv = (convId: string) => engine.typingIn(convId).length > 0;
    const contactItems: SidebarItem[] = contacts.map((c) => ({
      convId: c.convId,
      kind: "contact",
      id: c.id,
      title: c.label,
      status: c.status,
      unread: c.unread,
      preview: c.lastMessage
        ? (c.lastMessage.fromMe && !c.lastMessage.system ? "You: " : "") + c.lastMessage.body
        : c.status === "offline"
          ? `last seen ${ago(c.lastSeen)}`
          : null,
      time: c.lastMessage?.ts ?? null,
      typing: typingByConv(c.convId),
      muted: c.status === "offline",
      warn: c.keyChanged,
    }));
    const groupItems: SidebarItem[] = groups.map((g) => ({
      convId: g.id,
      kind: "group",
      id: g.id,
      title: g.name,
      status: null,
      unread: g.unread,
      preview: g.left
        ? "You left this group"
        : g.lastMessage
          ? g.lastMessage.system
            ? g.lastMessage.body
            : `${g.lastMessage.fromMe ? "You" : g.lastMessage.sender}: ${g.lastMessage.body}`
          : null,
      time: g.lastMessage?.ts ?? null,
      typing: typingByConv(g.id),
      muted: g.left,
      warn: false,
    }));
    return {
      contacts,
      groups,
      contactItems,
      groupItems,
      order: [...contactItems, ...groupItems].map((i) => i.convId),
      online: engine.onlineCount(),
      unread: contacts.reduce((n, c) => n + c.unread, 0) + groups.reduce((n, g) => n + g.unread, 0),
    };
  }, [engine, version]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` bumps on every engine change; it is the cache key
  const info = useMemo(() => (activeConv ? engine.conversationInfo(activeConv) : null), [engine, activeConv, version]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` bumps on every engine change; it is the cache key
  const messages = useMemo(() => {
    if (!activeConv) return [];
    const all = engine.messages(activeConv, limits[activeConv] ?? DEFAULT_LIMIT);
    const cut = clearedAt[activeConv];
    return cut ? all.filter((m) => m.ts > cut) : all;
  }, [engine, activeConv, version, limits, clearedAt]);

  // Terminal title with unread count.
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    process.stdout.write(`\x1b]0;${data.unread > 0 ? `ChaTTY (${data.unread})` : "ChaTTY"}\x07`);
  }, [data.unread]);

  // Keep the active conversation valid and tell the engine what's on screen.
  useEffect(() => {
    if (activeConv && !engine.conversationInfo(activeConv)) setActiveConv(data.order[0] ?? null);
  }, [engine, data.order, activeConv]);

  useEffect(() => {
    engine.setActiveConversation(activeConv);
    setScroll(0);
    setHighlight(null);
  }, [engine, activeConv]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-acknowledge reads whenever new messages arrive
  useEffect(() => {
    if (activeConv) engine.setActiveConversation(activeConv);
  }, [engine, activeConv, messages.length]);

  // ── layout ────────────────────────────────────────────────────────────

  const bodyH = Math.max(6, rows - 2);
  const compact = cols < 64;
  const sidebarW = compact ? cols : Math.max(26, Math.min(36, Math.floor(cols * 0.3)));
  const showSidebar = !compact || focus === "sidebar" || !activeConv;
  const showChat = !compact || (focus === "input" && !!activeConv);
  const chatW = compact ? cols : cols - sidebarW;

  const sugCtx = useMemo(
    () => ({
      users: data.contacts.map((c) => ({ label: c.label, status: c.status })),
      transfers: engine
        .transfers(30)
        .filter((t) => ["offered", "accepted", "in_progress"].includes(t.status))
        .map((t) => ({
          id: t.id,
          name: t.name,
          detail: `${t.direction === "in" ? "from" : "to"} ${t.peerLabel} · ${t.status}`,
        })),
    }),
    [data, engine],
  );
  const sugs = useMemo(
    () => (focus === "input" && !sugDismissed ? computeSuggestions(input.value, sugCtx) : []),
    [input.value, focus, sugDismissed, sugCtx],
  );
  const sugIdx = Math.min(sugIndex, Math.max(0, sugs.length - 1));

  const composerW = chatW;
  const compH = composerHeight(input.value, input.cursor, composerW - 6);
  const sugH = suggestionsHeight(sugs.length);
  const chatH = Math.max(5, bodyH - compH - sugH);
  const chatInner = chatW - 4;

  const layout = useMemo(() => buildChatLines(messages, chatInner), [messages, chatInner]);

  // Keep the reading position stable when new lines arrive while scrolled up.
  const prevLen = useRef(layout.lines.length);
  useEffect(() => {
    const delta = layout.lines.length - prevLen.current;
    prevLen.current = layout.lines.length;
    if (delta > 0) setScroll((s) => (s > 0 ? s + delta : 0));
  }, [layout.lines.length]);

  const maxScroll = Math.max(0, layout.lines.length - (chatH - 5));
  const page = Math.max(3, chatH - 7);

  // ── helpers ───────────────────────────────────────────────────────────

  const setValue = (value: string, cursor = graphemes(value).length) => {
    setInput({ value, cursor });
    setSugIndex(0);
    setSugDismissed(false);
  };

  const openConv = (convId: string, focusInput = true) => {
    setActiveConv(convId);
    if (focusInput) setFocus("input");
  };

  const cycle = (dir: 1 | -1) => {
    const order = data.order;
    if (order.length === 0) return;
    const i = activeConv ? order.indexOf(activeConv) : -1;
    const next = order[(i + dir + order.length) % order.length]!;
    setActiveConv(next);
  };

  const err = (text: string) => toast({ level: "error", title: "Oops", text }, 4500);
  const ok = (title: string, text: string) => toast({ level: "success", title, text });
  const infoToast = (title: string, text: string) => toast({ level: "info", title, text }, 4500);

  const resolveUser = (name: string | undefined): string | null => {
    if (!name) {
      err("Name a user, e.g. bob");
      return null;
    }
    const found = engine.findUser(name);
    if (found.length === 0) {
      err(`No peer called "${name}"`);
      return null;
    }
    if (found.length > 1) {
      err(`"${name}" is ambiguous: ${found.map((f) => f.label).join(", ")}`);
      return null;
    }
    return found[0]!.id;
  };

  const resolveTransfer = (arg: string | undefined, pred: (t: TransferView) => boolean): TransferView | null => {
    const candidates = engine.transfers(100).filter(pred);
    if (!arg) {
      const inConv = candidates.filter((t) => t.convId === activeConv);
      const pick = inConv[0] ?? candidates[0];
      if (!pick) err("No matching transfer");
      return pick ?? null;
    }
    const pick = candidates.find((t) => t.id.startsWith(arg) || t.name.toLowerCase() === arg.toLowerCase());
    if (!pick) err(`No transfer matching "${arg}"`);
    return pick ?? null;
  };

  const quit = async () => {
    if (quitting) return;
    setQuitting(true);
    setOverlay(null);
    try {
      await onQuit();
    } finally {
      exit();
    }
  };

  const requireConv = (): string | null => {
    if (!activeConv) {
      err("Open a conversation first");
      return null;
    }
    return activeConv;
  };

  const runCommand = async (spec: CommandSpec, args: string[], rest: string) => {
    switch (spec.name) {
      case "help":
        return setOverlay({ type: "help", scroll: 0 });
      case "quit":
        return quit();
      case "info":
        return setOverlay({ type: "info" });
      case "nick":
        if (!rest.trim()) return err("Usage: /nick <name>");
        engine.setDisplayName(rest);
        return ok("Name changed", `You are now ${engine.config.displayName}`);
      case "status": {
        const s = (args[0] ?? "").toLowerCase();
        if (s !== "online" && s !== "away") return err("Usage: /status online|away");
        engine.setStatus(s);
        return ok("Status", `You are ${s}`);
      }
      case "connect": {
        const target = args[0];
        if (!target) return err("Usage: /connect <host[:port]>");
        const m = target.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
        const host = m?.[1];
        const port = m?.[2] ? Number(m[2]) : 7878;
        if (!host || !(port > 0 && port < 65536)) return err("Usage: /connect <host[:port]>");
        engine.connect(host, port);
        return infoToast("Connecting", `Dialing ${host}:${port}…`);
      }
      case "peers":
        return setOverlay({ type: "peers", sel: 0 });
      case "notify":
      case "autoaccept": {
        const v = (args[0] ?? "").toLowerCase();
        if (v !== "on" && v !== "off") return err(`Usage: /${spec.name} on|off`);
        if (spec.name === "notify") engine.config.notifications = v === "on";
        else engine.config.autoAcceptFiles = v === "on";
        saveConfigQuiet(engine);
        return ok("Settings", `${spec.name === "notify" ? "Desktop notifications" : "Auto-accept files"} ${v}`);
      }
      case "msg": {
        const id = resolveUser(args[0]);
        if (!id) return;
        openConv(engine.ensureDirect(id));
        return;
      }
      case "search": {
        const conv = requireConv();
        if (!conv) return;
        if (!rest.trim()) return err("Usage: /search <text>");
        return setOverlay({ type: "search", query: rest.trim(), results: engine.search(conv, rest.trim()), sel: 0 });
      }
      case "history": {
        const conv = requireConv();
        if (!conv) return;
        const n = args[0] ? Number(args[0]) : 500;
        if (!Number.isInteger(n) || n <= 0) return err("Usage: /history [n]");
        setLimits((l) => ({ ...l, [conv]: n }));
        setClearedAt((c) => {
          const { [conv]: _, ...restC } = c;
          return restC;
        });
        return infoToast("History", `Showing up to ${n} messages`);
      }
      case "clear": {
        const conv = requireConv();
        if (!conv) return;
        setClearedAt((c) => ({ ...c, [conv]: Date.now() }));
        setScroll(0);
        return;
      }
      case "export": {
        const conv = requireConv();
        if (!conv) return;
        const file = exportConversation(engine, conv);
        return ok("Exported", file);
      }
      case "group create": {
        const name = args[0];
        if (!name) return err("Usage: /group create <name> [users…]");
        const ids: string[] = [];
        for (const u of args.slice(1)) {
          const id = resolveUser(u);
          if (!id) return;
          ids.push(id);
        }
        const id = engine.createGroup(name, ids);
        openConv(id);
        return ok(
          "Group created",
          `#${name.replace(/^#/, "")}${ids.length ? ` with ${ids.length} member${ids.length > 1 ? "s" : ""}` : " — invite people with /group invite"}`,
        );
      }
      case "group invite": {
        const conv = requireConv();
        if (!conv) return;
        if (!conv.startsWith("grp:")) return err("Open a group first");
        const id = resolveUser(args[0]);
        if (!id) return;
        engine.inviteToGroup(conv, id);
        return ok("Invited", `${engine.labelOf(id)} was added`);
      }
      case "group members": {
        const conv = requireConv();
        if (!conv) return;
        if (!conv.startsWith("grp:")) return err("Open a group first");
        return setOverlay({ type: "members" });
      }
      case "group leave": {
        const conv = requireConv();
        if (!conv) return;
        if (!conv.startsWith("grp:")) return err("Open a group first");
        engine.leaveGroup(conv);
        return infoToast("Left group", "You won't receive new messages");
      }
      case "group list":
        return setOverlay({ type: "groups", sel: 0 });
      case "file": {
        const conv = requireConv();
        if (!conv) return;
        if (!rest.trim()) return err("Usage: /file <path>");
        infoToast("Preparing", `Hashing ${path.basename(rest.trim())}…`);
        const t = await engine.sendFile(conv, rest.trim());
        return infoToast("File offered", `${t.name} (${formatBytes(t.size)}) — waiting for ${t.peerLabel}`);
      }
      case "files":
        return setOverlay({ type: "transfers", sel: 0 });
      case "accept": {
        const t = resolveTransfer(args[0], (x) => x.direction === "in" && x.status === "offered");
        if (t) engine.acceptFile(t.id);
        return;
      }
      case "decline": {
        const t = resolveTransfer(args[0], (x) => x.direction === "in" && x.status === "offered");
        if (t) engine.declineFile(t.id);
        return;
      }
      case "cancel": {
        const t = resolveTransfer(args[0], (x) => ["offered", "accepted", "in_progress"].includes(x.status));
        if (t) engine.cancelTransfer(t.id);
        return;
      }
      case "verify": {
        let id: string | null = null;
        if (args[0]) id = resolveUser(args[0]);
        else if (activeConv?.startsWith("dm:")) id = engine.peerOfDirect(activeConv);
        else return err("Usage: /verify <user>");
        if (id) setOverlay({ type: "verify", peerId: id });
        return;
      }
    }
  };

  const submit = async () => {
    const value = inputRef.current.value;
    if (!value.trim()) return;
    setHistory((h) => (h[h.length - 1] === value ? h : [...h.slice(-99), value]));
    setHistIdx(null);
    setValue("");
    setScroll(0);
    try {
      if (value.startsWith("/") && !value.startsWith("//")) {
        const parsed = parseCommand(value.trim());
        if (!parsed) return;
        if ("error" in parsed) return err(parsed.error);
        await runCommand(parsed.spec, parsed.args, parsed.rest);
        return;
      }
      const conv = activeConv;
      if (!conv) return err("Pick a conversation on the left first");
      await engine.sendText(conv, value.startsWith("//") ? value.slice(1) : value);
    } catch (e) {
      err((e as Error).message);
    }
  };

  // ── input editing ─────────────────────────────────────────────────────

  const edit = (fn: (g: string[], c: number) => { g: string[]; c: number }) => {
    const prev = inputRef.current;
    const r = fn(graphemes(prev.value), prev.cursor);
    const value = r.g.join("");
    setInput({ value, cursor: Math.max(0, Math.min(r.c, r.g.length)) });
    if (value !== prev.value) {
      setSugIndex(0);
      setSugDismissed(false);
      setHistIdx(null);
      if (activeConv && !value.startsWith("/") && value.length > 0) engine.notifyTyping(activeConv);
    }
  };

  const insert = (text: string) => {
    const clean = text
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    if (!clean) return;
    edit((g, c) => {
      const add = graphemes(clean);
      return { g: [...g.slice(0, c), ...add, ...g.slice(c)], c: c + add.length };
    });
  };

  const wordLeft = (g: string[], c: number) => {
    let i = c;
    while (i > 0 && /\s/.test(g[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(g[i - 1]!)) i--;
    return i;
  };
  const wordRight = (g: string[], c: number) => {
    let i = c;
    while (i < g.length && /\s/.test(g[i]!)) i++;
    while (i < g.length && !/\s/.test(g[i]!)) i++;
    return i;
  };

  const acceptSuggestion = (list = sugs) => {
    const s = list[Math.min(sugIdx, list.length - 1)];
    if (!s) return false;
    setValue(s.value);
    return true;
  };

  usePaste(
    (text) => {
      if (focusRef.current !== "input") setFocus("input");
      insert(text);
    },
    { isActive: !overlay && !quitting },
  );

  // ── overlay keys ──────────────────────────────────────────────────────

  const overlayKeys = (ch: string, key: Key) => {
    if (!overlay) return;
    const close = () => setOverlay(null);
    const move = (n: number, len: number) => (sel: number) => Math.max(0, Math.min(len - 1, sel + n));
    switch (overlay.type) {
      case "offer": {
        const t = engine.store.getTransfer(overlay.transferId);
        if (t?.status !== "offered") return close();
        try {
          if (ch.toLowerCase() === "y" || key.return) {
            engine.acceptFile(t.id);
            close();
          } else if (ch.toLowerCase() === "n") {
            engine.declineFile(t.id);
            close();
          } else if (key.escape) close();
        } catch (e) {
          err((e as Error).message);
          close();
        }
        return;
      }
      case "help":
        if (key.upArrow || ch === "k") setOverlay({ ...overlay, scroll: Math.max(0, overlay.scroll - 1) });
        else if (key.downArrow || ch === "j") setOverlay({ ...overlay, scroll: overlay.scroll + 1 });
        else if (key.pageDown) setOverlay({ ...overlay, scroll: overlay.scroll + 8 });
        else if (key.pageUp) setOverlay({ ...overlay, scroll: Math.max(0, overlay.scroll - 8) });
        else close();
        return;
      case "search": {
        const n = overlay.results.length;
        if (key.escape) return close();
        if (key.upArrow) return setOverlay({ ...overlay, sel: move(-1, n)(overlay.sel) });
        if (key.downArrow) return setOverlay({ ...overlay, sel: move(1, n)(overlay.sel) });
        if (key.return && n > 0) {
          const target = overlay.results[overlay.sel]!;
          jumpTo(target);
          return close();
        }
        return;
      }
      case "transfers": {
        const list = engine.transfers(30);
        const n = list.length;
        if (key.escape || ch === "q") return close();
        if (key.upArrow || ch === "k") return setOverlay({ ...overlay, sel: move(-1, n)(overlay.sel) });
        if (key.downArrow || ch === "j") return setOverlay({ ...overlay, sel: move(1, n)(overlay.sel) });
        const t = list[overlay.sel];
        if (!t) return;
        try {
          if (ch === "a") engine.acceptFile(t.id);
          else if (ch === "d") engine.declineFile(t.id);
          else if (ch === "c") engine.cancelTransfer(t.id);
          else if (key.return) {
            setOverlay(null);
            openConv(t.convId);
          }
        } catch (e) {
          err((e as Error).message);
        }
        return;
      }
      case "peers": {
        const list = engine.contacts();
        if (key.escape || ch === "q") return close();
        if (key.upArrow || ch === "k") return setOverlay({ ...overlay, sel: move(-1, list.length)(overlay.sel) });
        if (key.downArrow || ch === "j") return setOverlay({ ...overlay, sel: move(1, list.length)(overlay.sel) });
        if (key.return && list[overlay.sel]) {
          close();
          openConv(engine.ensureDirect(list[overlay.sel]!.id));
        }
        return;
      }
      case "groups": {
        const list = engine.groups();
        if (key.escape || ch === "q") return close();
        if (key.upArrow || ch === "k") return setOverlay({ ...overlay, sel: move(-1, list.length)(overlay.sel) });
        if (key.downArrow || ch === "j") return setOverlay({ ...overlay, sel: move(1, list.length)(overlay.sel) });
        if (key.return && list[overlay.sel]) {
          close();
          openConv(list[overlay.sel]!.id);
        }
        return;
      }
      case "verify":
        if (ch === "v") {
          engine.markVerified(overlay.peerId);
          ok("Verified", `${engine.labelOf(overlay.peerId)} marked as verified`);
        }
        return close();
      default:
        return close();
    }
  };

  const jumpTo = (m: MessageView) => {
    const idx = layout.owners.lastIndexOf(m.id);
    if (idx < 0) {
      // Not loaded — load more history and try to show it.
      setLimits((l) => ({
        ...l,
        [m.convId]: Math.max(l[m.convId] ?? DEFAULT_LIMIT, engine.store.messageCount(m.convId)),
      }));
      setHighlight(m.id);
      return;
    }
    const view = chatH - 5;
    const fromBottom = layout.lines.length - 1 - idx;
    setScroll(Math.max(0, Math.min(maxScroll, fromBottom - Math.floor(view / 2))));
    setHighlight(m.id);
    setTimeout(() => setHighlight((h) => (h === m.id ? null : h)), 4000);
  };

  // ── keyboard ──────────────────────────────────────────────────────────

  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "c") return void quit();
      if (overlay) return overlayKeys(ch, key);

      // Global shortcuts
      if ((key.ctrl && ch === "n") || (key.meta && key.downArrow)) return cycle(1);
      if ((key.ctrl && ch === "p") || (key.meta && key.upArrow)) return cycle(-1);
      if (key.ctrl && ch === "f") {
        setFocus("input");
        return setValue("/search ");
      }
      if (key.ctrl && ch === "t") return setOverlay({ type: "transfers", sel: 0 });
      if (key.pageUp || (key.shift && key.upArrow))
        return setScroll((s) => Math.min(maxScroll, s + (key.pageUp ? page : 1)));
      if (key.pageDown || (key.shift && key.downArrow))
        return setScroll((s) => Math.max(0, s - (key.pageDown ? page : 1)));

      if (focusRef.current === "sidebar") {
        const order = data.order;
        const i = activeConv ? order.indexOf(activeConv) : -1;
        if (key.upArrow || ch === "k") {
          if (order.length) setActiveConv(order[Math.max(0, i - 1)]!);
          return;
        }
        if (key.downArrow || ch === "j") {
          if (order.length) setActiveConv(order[Math.min(order.length - 1, i + 1)]!);
          return;
        }
        if (key.home) return order[0] && setActiveConv(order[0]);
        if (key.end) return order.length && setActiveConv(order[order.length - 1]!);
        if (key.return || key.rightArrow || key.tab) {
          if (!activeConv && order[0]) setActiveConv(order[0]);
          return setFocus("input");
        }
        if (key.escape) {
          setActiveConv(null);
          return;
        }
        if (ch === "q") return void quit();
        if (ch === "?") return setOverlay({ type: "help", scroll: 0 });
        if (ch && !key.ctrl && !key.meta && ch >= " ") {
          setFocus("input");
          insert(ch);
        }
        return;
      }

      // ── composer ──
      const live = sugDismissed ? [] : computeSuggestions(inputRef.current.value, sugCtx);
      const sugOpen = live.length > 0;
      if (key.escape) {
        if (sugOpen) return setSugDismissed(true);
        if (inputRef.current.value) return setValue("");
        return setFocus("sidebar");
      }
      if (key.tab) {
        if (sugOpen) return void acceptSuggestion(live);
        return setFocus("sidebar");
      }
      if (key.return) {
        if (sugOpen) {
          const s = live[Math.min(sugIdx, live.length - 1)]!;
          if (s.value.trimEnd() !== inputRef.current.value.trimEnd()) {
            const parsed = parseCommand(s.value.trim());
            const runNow = parsed && !("error" in parsed) && parsed.spec.args.length === 0 && !s.value.endsWith(" ");
            if (!runNow) return void acceptSuggestion(live);
            setHistory((h) => [...h.slice(-99), s.value.trim()]);
            setValue("");
            void runCommand(parsed.spec, parsed.args, parsed.rest).catch((e) => err((e as Error).message));
            return;
          }
        }
        if (key.meta || key.shift) return insert("\n");
        return void submit();
      }
      if (key.upArrow) {
        if (sugOpen) return setSugIndex((i) => (Math.min(i, live.length - 1) - 1 + live.length) % live.length);
        if (history.length && (inputRef.current.value === "" || histIdx !== null)) {
          const idx = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
          setHistIdx(idx);
          const v = history[idx]!;
          setInput({ value: v, cursor: graphemes(v).length });
          setSugDismissed(true);
          return;
        }
        return;
      }
      if (key.downArrow) {
        if (sugOpen) return setSugIndex((i) => (Math.min(i, live.length - 1) + 1) % live.length);
        if (histIdx !== null) {
          const idx = histIdx + 1;
          if (idx >= history.length) {
            setHistIdx(null);
            setInput({ value: "", cursor: 0 });
          } else {
            setHistIdx(idx);
            const v = history[idx]!;
            setInput({ value: v, cursor: graphemes(v).length });
          }
          setSugDismissed(true);
        }
        return;
      }
      if (key.leftArrow) {
        if (key.meta || key.ctrl) return edit((g, c) => ({ g, c: wordLeft(g, c) }));
        return edit((g, c) => ({ g, c: c - 1 }));
      }
      if (key.rightArrow) {
        if (key.meta || key.ctrl) return edit((g, c) => ({ g, c: wordRight(g, c) }));
        return edit((g, c) => ({ g, c: c + 1 }));
      }
      if (key.home || (key.ctrl && ch === "a")) return edit((g) => ({ g, c: 0 }));
      if (key.end || (key.ctrl && ch === "e")) {
        if (inputRef.current.value === "" || inputRef.current.cursor >= graphemes(inputRef.current.value).length)
          setScroll(0);
        return edit((g) => ({ g, c: g.length }));
      }
      if (key.backspace) {
        if (key.meta)
          return edit((g, c) => {
            const s = wordLeft(g, c);
            return { g: [...g.slice(0, s), ...g.slice(c)], c: s };
          });
        return edit((g, c) => (c > 0 ? { g: [...g.slice(0, c - 1), ...g.slice(c)], c: c - 1 } : { g, c }));
      }
      if (key.delete) return edit((g, c) => ({ g: [...g.slice(0, c), ...g.slice(c + 1)], c }));
      if (key.ctrl && ch === "w")
        return edit((g, c) => {
          const s = wordLeft(g, c);
          return { g: [...g.slice(0, s), ...g.slice(c)], c: s };
        });
      if (key.ctrl && ch === "u") return edit((g, c) => ({ g: g.slice(c), c: 0 }));
      if (key.ctrl && ch === "k") return edit((g, c) => ({ g: g.slice(0, c), c }));
      if (key.meta && ch === "b") return edit((g, c) => ({ g, c: wordLeft(g, c) }));
      if (key.meta && ch === "f") return edit((g, c) => ({ g, c: wordRight(g, c) }));
      if (key.ctrl || key.meta) return;
      if (ch) insert(ch);
    },
    { isActive: !quitting },
  );

  // ── render ────────────────────────────────────────────────────────────

  const placeholder = !activeConv
    ? "Pick a conversation, or type / for commands"
    : info?.type === "group" && info.group?.left
      ? "You left this group"
      : `Message ${info?.type === "group" ? "#" : ""}${info?.title ?? ""}…`;

  const hints: Hint[] = overlay
    ? [["Esc", "close"]]
    : focus === "sidebar"
      ? [
          ["↑↓", "navigate"],
          ["Enter", "open"],
          ["/", "command"],
          ["Ctrl+N/P", "switch"],
          ["?", "help"],
          ["q", "quit"],
        ]
      : sugs.length
        ? [
            ["↑↓", "select"],
            ["Tab", "complete"],
            ["Enter", "run"],
            ["Esc", "dismiss"],
          ]
        : [
            ["Enter", "send"],
            ["Esc", "back"],
            ["PgUp/PgDn", "scroll"],
            ["/", "commands"],
            ["Ctrl+F", "search"],
            ["Ctrl+T", "files"],
            ["Ctrl+C", "quit"],
          ];

  if (quitting) {
    return (
      <Box width={cols} height={rows} alignItems="center" justifyContent="center" flexDirection="column">
        <Text color={theme.accent} bold>
          ◆ ChaTTY
        </Text>
        <Text color={theme.muted}>Saying goodbye to peers…</Text>
      </Box>
    );
  }

  const me = engine.me;
  return (
    <Box width={cols} height={rows} flexDirection="column">
      <Header
        width={cols}
        name={me.displayName}
        status={me.status}
        online={data.online}
        known={data.contacts.length}
        port={engine.port}
        unread={data.unread}
      />
      <Box height={bodyH} flexDirection="row">
        {showSidebar ? (
          <Sidebar
            width={sidebarW}
            height={bodyH}
            focused={focus === "sidebar" && !overlay}
            contacts={data.contactItems}
            groups={data.groupItems}
            selected={activeConv}
            onlineCount={data.online}
          />
        ) : null}
        {showChat ? (
          <Box flexDirection="column" width={chatW} height={bodyH}>
            {activeConv && info ? (
              <ChatView
                width={chatW}
                height={chatH}
                focused={focus === "input" && !overlay}
                info={info}
                lines={layout.lines}
                owners={layout.owners}
                scroll={Math.min(scroll, maxScroll)}
                typing={engine.typingIn(activeConv)}
                highlight={highlight}
              />
            ) : (
              <Welcome
                width={chatW}
                height={chatH}
                addresses={engine.info().addresses}
                port={engine.port}
                online={data.online}
                known={data.contacts.length}
                name={me.displayName}
              />
            )}
            <Suggestions items={sugs} selected={sugIdx} width={chatW} />
            <Composer
              width={composerW}
              value={input.value}
              cursor={input.cursor}
              focused={focus === "input" && !overlay}
              placeholder={placeholder}
            />
          </Box>
        ) : null}
      </Box>
      <Footer width={cols} hints={hints} />
      {overlay ? (
        <OverlayView overlay={overlay} engine={engine} cols={cols} rows={rows} activeConv={activeConv} />
      ) : null}
      <Toasts toasts={overlay ? [] : toasts} screenWidth={cols} />
    </Box>
  );
}

function saveConfigQuiet(engine: ChatEngine) {
  try {
    engine.saveSettings();
  } catch {}
}

function exportConversation(engine: ChatEngine, convId: string): string {
  const info = engine.conversationInfo(convId);
  const msgs = engine.messages(convId, 1_000_000);
  const lines = [
    `# ChaTTY conversation: ${info?.type === "group" ? "#" : ""}${info?.title ?? convId}`,
    `# exported ${new Date().toISOString()}`,
    "",
  ];
  for (const m of msgs) {
    const when = new Date(m.ts).toLocaleString();
    if (m.kind === "system") lines.push(`[${when}] * ${m.body}`);
    else if (m.kind === "file") lines.push(`[${when}] ${m.fromMe ? "You" : m.senderLabel}: [file] ${m.body}`);
    else lines.push(`[${when}] ${m.fromMe ? "You" : m.senderLabel}: ${m.body}`);
  }
  const safe = (info?.title ?? "chat").replace(/[^\p{L}\p{N}_-]+/gu, "_");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  fs.mkdirSync(engine.config.downloadsDir, { recursive: true });
  const file = path.join(engine.config.downloadsDir, `chat-${safe}-${stamp}.txt`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

// ── overlays ────────────────────────────────────────────────────────────

function OverlayView({
  overlay,
  engine,
  cols,
  rows,
  activeConv,
}: {
  overlay: Overlay;
  engine: ChatEngine;
  cols: number;
  rows: number;
  activeConv: string | null;
}) {
  const W = Math.min(76, cols - 4);
  const inner = W - 4;
  const bodyRows = (h: number) => Math.min(h, rows - 2) - 5;

  switch (overlay.type) {
    case "help": {
      const lines: Array<{ l: string; r: string; head?: boolean }> = [];
      const sections = ["General", "Chat", "Groups", "Files", "Security"] as const;
      for (const s of sections) {
        lines.push({ l: s.toUpperCase(), r: "", head: true });
        for (const c of COMMANDS.filter((x) => x.section === s)) lines.push({ l: c.usage, r: c.description });
        lines.push({ l: "", r: "" });
      }
      lines.push({ l: "SHORTCUTS", r: "", head: true });
      for (const [k, d] of [
        ["↑↓ / j k", "Move between chats (sidebar)"],
        ["Enter / Tab", "Open chat · focus the message box"],
        ["Esc", "Back to the sidebar · close popups"],
        ["Ctrl+N / Ctrl+P", "Next / previous chat from anywhere"],
        ["PgUp / PgDn", "Scroll messages (Shift+↑↓ for one line)"],
        ["End", "Jump to the newest message"],
        ["↑ / ↓", "Previous / next sent message (empty input)"],
        ["Ctrl+W / Ctrl+U", "Delete word / line"],
        ["Alt+Enter", "New line in a message"],
        ["Ctrl+F · Ctrl+T", "Search · file transfers"],
        ["//text", "Send a message that starts with /"],
      ])
        lines.push({ l: k!, r: d! });
      const h = Math.min(rows - 2, 32);
      const view = bodyRows(h);
      const start = Math.min(overlay.scroll, Math.max(0, lines.length - view));
      const lw = 30;
      return (
        <Modal
          screenWidth={cols}
          screenHeight={rows}
          width={W}
          height={h}
          title="◆ ChaTTY — Help"
          footer="↑↓ scroll · any key to close"
        >
          {lines.slice(start, start + view).map((x, i) => (
            <Text key={i} backgroundColor={theme.base}>
              {x.head ? (
                <Text color={theme.accent2} bold>
                  {padEnd(x.l, inner)}
                </Text>
              ) : (
                <>
                  <Text color={theme.peach}>{padEnd(truncate(x.l, lw - 1), lw)}</Text>
                  <Text color={theme.subtext}>{padEnd(truncate(x.r, inner - lw), inner - lw)}</Text>
                </>
              )}
            </Text>
          ))}
        </Modal>
      );
    }
    case "search": {
      const rowsList: ListRow[] = overlay.results.map((m) => ({
        key: m.id,
        left: `${m.fromMe ? "You" : m.senderLabel}: ${m.body.replace(/\s+/g, " ")}`,
        right: shortTime(m.ts) === clock(m.ts) ? clock(m.ts) : `${shortTime(m.ts)} ${clock(m.ts)}`,
        color: theme.text,
      }));
      const h = Math.min(rows - 2, 22);
      return (
        <Modal
          screenWidth={cols}
          screenHeight={rows}
          width={W}
          height={h}
          title={`🔍 "${truncate(overlay.query, 30)}" — ${overlay.results.length} result${overlay.results.length === 1 ? "" : "s"}${overlay.results.length === 50 ? " (max)" : ""}`}
          footer="↑↓ select · Enter jump to message · Esc close"
        >
          <ModalList rows={rowsList} selected={overlay.sel} width={W} height={bodyRows(h)} empty="No messages match." />
        </Modal>
      );
    }
    case "transfers": {
      const list = engine.transfers(30);
      const rowsList: ListRow[] = list.map((t) => {
        const pct = t.size ? Math.floor((t.bytes / t.size) * 100) : 100;
        const statusText =
          t.status === "in_progress" || t.status === "accepted"
            ? `${pct}%`
            : t.status === "complete"
              ? "done"
              : t.status;
        const statusCol =
          t.status === "complete"
            ? theme.green
            : t.status === "failed" || t.status === "declined" || t.status === "cancelled"
              ? theme.red
              : theme.yellow;
        return {
          key: t.id,
          left: `${t.direction === "in" ? "↓" : "↑"} ${t.name}`,
          right: `${formatBytes(t.size)}  ${statusText}`,
          rightColor: statusCol,
          sub: `${t.direction === "in" ? "from" : "to"} ${t.peerLabel} · ${shortTime(t.createdAt)}${t.error ? ` · ${t.error}` : ""}${t.path && t.direction === "in" && t.status === "complete" ? ` · ${t.path}` : ""}`,
        };
      });
      const h = Math.min(rows - 2, 24);
      return (
        <Modal
          screenWidth={cols}
          screenHeight={rows}
          width={W}
          height={h}
          title="⇅ File transfers"
          footer="a accept · d decline · c cancel · Enter open chat · Esc close"
        >
          <ModalList
            rows={rowsList}
            selected={overlay.sel}
            width={W}
            height={bodyRows(h)}
            empty="No transfers yet. Send one with /file <path>."
          />
        </Modal>
      );
    }
    case "peers": {
      const list = engine.contacts();
      const rowsList: ListRow[] = list.map((c) => {
        const u = engine.store.getUser(c.id);
        return {
          key: c.id,
          left: `${statusGlyph[c.status]} ${c.label}${c.label !== c.username ? `  (@${c.username})` : ""}`,
          color: c.status === "offline" ? theme.muted : theme.text,
          right: c.status === "offline" ? `seen ${ago(c.lastSeen)}` : c.status,
          rightColor: statusColor[c.status],
          sub: `${u?.host ?? "?"}:${u?.port ?? "?"} · id ${c.id.slice(0, 8)}${c.keyChanged ? " · ⚠ key changed" : ""}`,
        };
      });
      const h = Math.min(rows - 2, 24);
      return (
        <Modal
          screenWidth={cols}
          screenHeight={rows}
          width={W}
          height={h}
          title={`👥 Peers — ${engine.onlineCount()} online`}
          footer="Enter message · Esc close"
        >
          <ModalList
            rows={rowsList}
            selected={overlay.sel}
            width={W}
            height={bodyRows(h)}
            empty="No peers found yet. Try /connect <host:port>."
          />
        </Modal>
      );
    }
    case "groups": {
      const list = engine.groups();
      const rowsList: ListRow[] = list.map((g) => ({
        key: g.id,
        left: `# ${g.name}`,
        color: g.left ? theme.muted : theme.accent2,
        right: g.left ? "left" : `${g.members.length} members`,
        sub: g.members.map((m) => (m.isMe ? "you" : m.label)).join(", "),
      }));
      const h = Math.min(rows - 2, 22);
      return (
        <Modal
          screenWidth={cols}
          screenHeight={rows}
          width={W}
          height={h}
          title="# Your groups"
          footer="Enter open · Esc close"
        >
          <ModalList
            rows={rowsList}
            selected={overlay.sel}
            width={W}
            height={bodyRows(h)}
            empty="No groups yet. Create one with /group create <name>."
          />
        </Modal>
      );
    }
    case "members": {
      const g = engine.groups().find((x) => x.id === activeConv);
      const members = g?.members ?? [];
      const h = Math.min(rows - 2, Math.max(8, members.length + 6));
      return (
        <Modal
          screenWidth={cols}
          screenHeight={rows}
          width={Math.min(W, 50)}
          height={h}
          title={`# ${g?.name ?? "group"} — members`}
          footer="Esc close"
        >
          {members.map((m) => (
            <Text key={m.id} backgroundColor={theme.base}>
              <Text color={statusColor[m.status]}>{statusGlyph[m.status]} </Text>
              <Text color={theme.text} bold={m.isMe}>
                {padEnd(truncate(m.isMe ? `${m.label} (you)` : m.label, Math.min(W, 50) - 8), Math.min(W, 50) - 6)}
              </Text>
            </Text>
          ))}
        </Modal>
      );
    }
    case "info": {
      const i = engine.info();
      const rowsInfo: Array<[string, string]> = [
        ["Name", `${i.displayName}  (@${i.username})`],
        ["Status", i.status],
        ["User ID", i.id],
        ["Listening", `port ${i.port}`],
        ["Addresses", i.addresses.length ? i.addresses.map((a) => `${a}:${i.port}`).join("  ") : "no LAN address"],
        ["Peers online", String(i.online)],
        ["Fingerprint", i.fingerprint],
        ["Downloads", i.downloadsDir],
        ["Encryption", "X25519 + AES-256-GCM, Ed25519 identity"],
      ];
      return (
        <Modal
          screenWidth={cols}
          screenHeight={rows}
          width={W}
          height={rowsInfo.length + 7}
          title="ℹ About you"
          footer={`Share: chatty --peer ${i.addresses[0] ?? "<your-ip>"}:${i.port} · any key to close`}
        >
          {rowsInfo.map(([k, v]) => (
            <Text key={k} backgroundColor={theme.base}>
              <Text color={theme.muted}>{padEnd(k, 14)}</Text>
              <Text color={theme.text}>{padEnd(truncate(v, inner - 14), inner - 14)}</Text>
            </Text>
          ))}
        </Modal>
      );
    }
    case "verify": {
      const num = engine.safetyNumberWith(overlay.peerId);
      const label = engine.labelOf(overlay.peerId);
      const u = engine.store.getUser(overlay.peerId);
      const text = num
        ? `Compare this number with ${label} (in person or on a call). If it matches on both screens, nobody is intercepting your chats.`
        : `No key stored for ${label} yet — connect to them first.`;
      const body = wrapSegments([{ text }], Math.min(W, 60) - 4);
      return (
        <Modal
          screenWidth={cols}
          screenHeight={rows}
          width={Math.min(W, 60)}
          height={body.length + 9}
          title={`🔐 Verify ${label}`}
          color={u?.key_changed ? theme.yellow : theme.green}
          footer="v mark as verified · any key to close"
        >
          {body.map((l, i) => (
            <Text key={i} backgroundColor={theme.base} color={theme.subtext}>
              {padEnd(l.map((s) => s.text).join(""), Math.min(W, 60) - 4)}
            </Text>
          ))}
          <Text backgroundColor={theme.base}> </Text>
          <Text backgroundColor={theme.base} color={theme.green} bold>
            {padEnd(num ? `   ${num}` : "", Math.min(W, 60) - 4)}
          </Text>
          <Text backgroundColor={theme.base} color={u?.key_changed ? theme.yellow : theme.muted}>
            {padEnd(u?.key_changed ? "   ⚠ Their key changed since you last talked" : "", Math.min(W, 60) - 4)}
          </Text>
        </Modal>
      );
    }
    case "offer": {
      const t = engine.store.getTransfer(overlay.transferId);
      if (!t) return null;
      const from = engine.labelOf(t.peer_id);
      const MW = Math.min(W, 58);
      const mi = MW - 4;
      return (
        <Modal
          screenWidth={cols}
          screenHeight={rows}
          width={MW}
          height={10}
          title="📎 Incoming file"
          color={theme.peach}
        >
          <Text backgroundColor={theme.base}>
            <Text color={theme.text} bold>
              {truncate(from, 20)}
            </Text>
            <Text color={theme.subtext}>{padEnd(" wants to send you:", mi - strWidth(truncate(from, 20)))}</Text>
          </Text>
          <Text backgroundColor={theme.base}> </Text>
          <Text backgroundColor={theme.base}>
            <Text color={theme.peach} bold>
              {`  ${truncate(t.name, mi - 16)}`}
            </Text>
            <Text color={theme.muted}>
              {padEnd(`  ${formatBytes(t.size)}`, mi - 2 - strWidth(truncate(t.name, mi - 16)))}
            </Text>
          </Text>
          <Text backgroundColor={theme.base}> </Text>
          <Text backgroundColor={theme.base}>
            <Text color={theme.base} backgroundColor={theme.green} bold>
              {" Y  Accept "}
            </Text>
            <Text>{"   "}</Text>
            <Text color={theme.base} backgroundColor={theme.red} bold>
              {" N  Decline "}
            </Text>
            <Text color={theme.muted}>{padEnd("   Esc later", mi - 27)}</Text>
          </Text>
        </Modal>
      );
    }
  }
}
