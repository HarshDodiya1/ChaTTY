import { spawn } from "node:child_process";

/** Best-effort desktop notification. Silently does nothing when unsupported. */
export function desktopNotify(title: string, body: string): void {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const t = clip(title, 64);
  const b = clip(body.replace(/\s+/g, " "), 180);
  try {
    if (process.platform === "darwin") {
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      run("osascript", ["-e", `display notification "${esc(b)}" with title "${esc(t)}"`]);
    } else if (process.platform === "linux") {
      run("notify-send", ["--app-name=ChaTTY", t, b]);
    }
  } catch {
    // no notifier available
  }
}

function run(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
