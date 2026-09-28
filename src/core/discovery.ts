// LAN peer discovery over mDNS (service type `_chatty._tcp.local.`).
// Each instance advertises its user id in the TXT record and browses for others.

import { EventEmitter } from "node:events";
import os from "node:os";
import { Bonjour, type Browser, type Service } from "bonjour-service";
import type { Logger } from "../util/logger.ts";

export const SERVICE_TYPE = "chatty";

export interface DiscoveredPeer {
  userId: string;
  username: string;
  host: string;
  port: number;
}

export interface DiscoveryEvents {
  peer: [DiscoveredPeer];
}

export interface Discovery extends EventEmitter<DiscoveryEvents> {
  start(): void;
  stop(): Promise<void>;
}

export class MdnsDiscovery extends EventEmitter<DiscoveryEvents> implements Discovery {
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private refresh: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly self: { userId: string; username: string; port: number },
    private readonly log: Logger,
  ) {
    super();
  }

  start(): void {
    try {
      this.bonjour = new Bonjour({}, (err: Error) => this.log.warn("mDNS error", err.message));
      this.bonjour.publish({
        name: `ChaTTY ${this.self.username} ${this.self.userId.slice(0, 8)}`,
        type: SERVICE_TYPE,
        port: this.self.port,
        txt: { id: this.self.userId, user: this.self.username, v: "2" },
        disableIPv6: true,
      });
      this.browser = this.bonjour.find({ type: SERVICE_TYPE }, (svc: Service) => this.onService(svc));
      // Re-query periodically so peers that missed our announcement still find us.
      this.refresh = setInterval(() => this.browser?.update(), 15_000);
      this.log.info(`mDNS advertising _${SERVICE_TYPE}._tcp on port ${this.self.port}`);
    } catch (err) {
      this.log.warn("mDNS unavailable", (err as Error).message);
    }
  }

  private onService(svc: Service): void {
    const txt = (svc.txt ?? {}) as Record<string, unknown>;
    const userId = typeof txt.id === "string" ? txt.id : null;
    if (!userId || userId === this.self.userId) return;
    const host = pickAddress(svc);
    if (!host) return;
    const peer = { userId, username: typeof txt.user === "string" ? txt.user : "unknown", host, port: svc.port };
    this.log.info(`mDNS found ${peer.username} at ${host}:${peer.port}`);
    this.emit("peer", peer);
  }

  async stop(): Promise<void> {
    if (this.refresh) clearInterval(this.refresh);
    this.browser?.stop();
    const b = this.bonjour;
    this.bonjour = null;
    if (!b) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      b.unpublishAll(() => {
        clearTimeout(t);
        resolve();
      });
    });
    try {
      b.destroy();
    } catch {}
  }
}

/** Prefer an IPv4 address from the advertised records, then the packet source. */
function pickAddress(svc: Service): string | null {
  const v4 = (svc.addresses ?? []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const nonLoop = v4.find((a) => !a.startsWith("127."));
  if (nonLoop) return nonLoop;
  if (v4[0]) return v4[0];
  if (svc.referer?.family === "IPv4") return svc.referer.address;
  return null;
}

/** Non-internal IPv4 addresses of this machine, for display in /info. */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}
