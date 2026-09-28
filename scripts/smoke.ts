#!/usr/bin/env bun

// End-to-end smoke run of the real app: two instances in pseudo-terminals,
// B dials A, both must list each other, B sends a message that must appear on
// A's screen, then both quit cleanly with exit code 0.
//
//   bun scripts/smoke.ts                 # runs `bun src/cli.tsx`
//   bun scripts/smoke.ts dist/x/chatty   # runs a compiled binary

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Terminal } from "@xterm/headless";

const COLS = 110;
const ROWS = 32;
const root = path.resolve(import.meta.dir, "..");
const binary = process.argv[2];
const baseCmd = binary ? [path.resolve(binary)] : ["bun", path.join(root, "src/cli.tsx")];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface Instance {
  name: string;
  proc: Bun.Subprocess;
  screen: () => string;
  write: (s: string) => void;
}

function launch(name: string, args: string[]): Instance {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const proc = Bun.spawn([...baseCmd, ...args], {
    cwd: root,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: { cols: COLS, rows: ROWS, data: (_t, data) => term.write(data) },
  });
  return {
    name,
    proc,
    write: (s) => proc.terminal!.write(s),
    screen: () => {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < ROWS; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "");
      return lines.join("\n");
    },
  };
}

async function waitFor(inst: Instance, text: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (inst.screen().includes(text)) return;
    if (inst.proc.exitCode !== null) break;
    await Bun.sleep(100);
  }
  throw new Error(`${inst.name}: timed out waiting for "${text}"\n${inst.screen()}`);
}

async function step(label: string, fn: () => Promise<void>) {
  const t0 = performance.now();
  await fn();
  console.log(`  ✔ ${label} (${Math.round(performance.now() - t0)} ms)`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatty-smoke-"));
const [portA, portB] = [await freePort(), await freePort()];
const common = ["--no-mdns"];
let a: Instance | undefined;
let b: Instance | undefined;

console.log(`ChaTTY smoke test — ${baseCmd.join(" ")}`);
try {
  a = launch("A", ["--name", "smoke-a", "--port", String(portA), "--data-dir", path.join(tmp, "a"), ...common]);
  await step("A starts and renders", () => waitFor(a!, "ChaTTY"));
  b = launch("B", [
    "--name",
    "smoke-b",
    "--port",
    String(portB),
    "--data-dir",
    path.join(tmp, "b"),
    "--peer",
    `127.0.0.1:${portA}`,
    ...common,
  ]);
  await step("B sees A", () => waitFor(b!, "smoke-a"));
  await step("A sees B (inbound only)", () => waitFor(a!, "smoke-b"));
  await step("B sends a message A receives", async () => {
    b!.write("\r");
    await Bun.sleep(300);
    b!.write("\x1b[200~hello from the smoke test\x1b[201~");
    await Bun.sleep(200);
    b!.write("\r");
    await waitFor(a!, "hello from the smoke test");
  });
  await step("both quit cleanly", async () => {
    for (const inst of [a!, b!]) inst.write("\x03");
    const codes = await Promise.race([Promise.all([a!.proc.exited, b!.proc.exited]), Bun.sleep(8000).then(() => null)]);
    if (!codes) throw new Error("instances did not exit within 8s");
    if (codes.some((c) => c !== 0)) throw new Error(`non-zero exit codes: ${codes.join(", ")}`);
  });
  console.log("smoke test passed");
} catch (err) {
  console.error(`✖ ${(err as Error).message}`);
  for (const dir of ["a", "b"]) {
    const log = path.join(tmp, dir, "chatty.log");
    if (fs.existsSync(log)) console.error(`--- ${dir}/chatty.log ---\n${fs.readFileSync(log, "utf8").slice(-3000)}`);
  }
  process.exitCode = 1;
} finally {
  for (const inst of [a, b]) if (inst && inst.proc.exitCode === null) inst.proc.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
}
