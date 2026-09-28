#!/usr/bin/env bun
import path from "node:path";
import { render } from "ink";
import pkg from "../package.json" with { type: "json" };
import { DEFAULT_PORT, defaultDataDir, loadOrCreateConfig, pathsFor, sanitizeName, saveConfig } from "./config.ts";
import { Identity } from "./core/crypto.ts";
import { MdnsDiscovery } from "./core/discovery.ts";
import { ChatEngine, type Notice } from "./core/engine.ts";
import { Store } from "./store/db.ts";
import { App } from "./ui/App.tsx";
import { Logger, type LogLevel } from "./util/logger.ts";

// Release builds inject the tag version at compile time (see scripts/build.ts).
declare const CHATTY_VERSION: string | undefined;
const VERSION = typeof CHATTY_VERSION === "string" ? CHATTY_VERSION : pkg.version;

const HELP = `
  ◆ ChaTTY ${VERSION} — peer-to-peer LAN chat with end-to-end encryption

  Usage
    chatty [options]

  Options
    --name <name>        Set your username (saved for next time)
    --port <port>        Listen port (default ${DEFAULT_PORT})
    --peer <host:port>   Connect to a peer directly (repeatable)
    --data-dir <dir>     Data directory (default ~/.chatty-v2)
    --no-mdns            Disable LAN auto-discovery
    --auto-accept        Accept incoming files automatically
    --debug              Verbose logging to <data-dir>/chatty.log
    -v, --version        Print version
    -h, --help           Show this help

  Examples
    chatty --name alice
    chatty --name bob --port 7879 --data-dir ~/.chatty-bob --peer 127.0.0.1:7878
`;

interface Args {
  name?: string;
  port?: number;
  peers: Array<{ host: string; port: number }>;
  dataDir?: string;
  mdns: boolean;
  autoAccept: boolean;
  debug: boolean;
}

function fail(msg: string): never {
  process.stderr.write(`chatty: ${msg}\n`);
  process.exit(2);
}

function parsePeer(v: string): { host: string; port: number } {
  const m = v.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  const port = m?.[2] ? Number(m[2]) : DEFAULT_PORT;
  if (!m?.[1] || !(port > 0 && port < 65536)) fail(`invalid --peer "${v}" (expected host:port)`);
  return { host: m[1], port };
}

function parseArgs(argv: string[]): Args {
  const args: Args = { peers: [], mdns: true, autoAccept: false, debug: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] =
      a.startsWith("--") && a.includes("=")
        ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
        : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("-"))) fail(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        return process.exit(0);
      case "-v":
      case "--version":
        process.stdout.write(`${VERSION}\n`);
        return process.exit(0);
      case "--name": {
        const n = sanitizeName(value());
        if (!n) fail("--name must contain letters or digits");
        args.name = n;
        break;
      }
      case "--port": {
        const p = Number(value());
        if (!Number.isInteger(p) || p < 0 || p > 65535) fail("--port must be 0-65535");
        args.port = p;
        break;
      }
      case "--peer":
        args.peers.push(parsePeer(value()));
        break;
      case "--data-dir":
        args.dataDir = path.resolve(value().replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
        break;
      case "--no-mdns":
        args.mdns = false;
        break;
      case "--auto-accept":
        args.autoAccept = true;
        break;
      case "--debug":
        args.debug = true;
        break;
      default:
        fail(`unknown option ${a} (see --help)`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("ChaTTY needs an interactive terminal");

  const paths = pathsFor(args.dataDir ?? defaultDataDir());
  const { config, created } = loadOrCreateConfig(paths);
  if (args.name && args.name !== config.username) {
    config.username = args.name;
    config.displayName = args.name;
  }
  if (args.port !== undefined) config.port = args.port;
  if (args.autoAccept) config.autoAcceptFiles = true;
  saveConfig(paths, config);

  const level: LogLevel = args.debug ? "debug" : ((process.env.CHATTY_LOG as LogLevel) ?? "info");
  const log = new Logger(level, paths.logFile);
  log.info(`ChaTTY ${VERSION} starting (bun ${Bun.version}, data ${paths.dataDir})`);

  const identity = Identity.loadOrCreate(paths.identityFile);
  const store = new Store(paths.dbFile);
  const engine = new ChatEngine({
    config,
    store,
    identity,
    log,
    saveConfig: (c) => saveConfig(paths, c),
    discovery: args.mdns ? (self) => new MdnsDiscovery(self, log.child("mdns")) : undefined,
  });

  try {
    await engine.start();
  } catch (err) {
    store.close();
    fail((err as Error).message);
  }
  for (const p of args.peers) engine.connect(p.host, p.port);

  process.on("uncaughtException", (err) => log.error("uncaught exception", err));
  process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));

  const notices: Notice[] = [];
  if (created)
    notices.push({
      level: "success",
      title: `Welcome, ${config.displayName}!`,
      text: "Your identity and encryption keys were created. Type /help to get started.",
    });
  if (!args.mdns)
    notices.push({ level: "info", title: "Discovery off", text: "mDNS is disabled — use --peer or /connect." });

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await engine.stop().catch((e) => log.error("stop failed", e));
  };

  const instance = render(<App engine={engine} onQuit={shutdown} startupNotices={notices} />, {
    alternateScreen: true,
    incrementalRendering: true,
    exitOnCtrlC: false,
    maxFps: 60,
  });

  const onSignal = async () => {
    await shutdown();
    instance.unmount();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  await instance.waitUntilExit();
  await shutdown();
  store.close();
  log.info("bye");
  log.close();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`chatty: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
