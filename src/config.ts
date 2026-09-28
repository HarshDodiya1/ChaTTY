import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 7878;

export interface Config {
  userId: string;
  username: string;
  displayName: string;
  port: number;
  autoAcceptFiles: boolean;
  notifications: boolean;
  downloadsDir: string;
}

export interface Paths {
  dataDir: string;
  configFile: string;
  dbFile: string;
  identityFile: string;
  logFile: string;
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), ".chatty-v2");
}

export function pathsFor(dataDir: string): Paths {
  return {
    dataDir,
    configFile: path.join(dataDir, "config.json"),
    dbFile: path.join(dataDir, "chatty.db"),
    identityFile: path.join(dataDir, "identity.key"),
    logFile: path.join(dataDir, "chatty.log"),
  };
}

/** Username derived from the hostname: lowercase, safe characters only. */
export function defaultUsername(): string {
  const host = os.hostname().split(".")[0] ?? "user";
  return sanitizeName(host) || "user";
}

export function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_.-]/gu, "")
    .slice(0, 24);
}

/** Load `config.json`, creating it on first run. Never loses unknown-but-valid fields. */
export function loadOrCreateConfig(paths: Paths): { config: Config; created: boolean } {
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  let raw: Partial<Config> = {};
  let created = false;
  if (fs.existsSync(paths.configFile)) {
    try {
      raw = JSON.parse(fs.readFileSync(paths.configFile, "utf8"));
    } catch {
      // A corrupt config is replaced, but the user id is regenerated only if missing.
      raw = {};
    }
  } else {
    created = true;
  }
  const username = raw.username && sanitizeName(raw.username) ? sanitizeName(raw.username) : defaultUsername();
  const config: Config = {
    userId: typeof raw.userId === "string" && raw.userId.length >= 8 ? raw.userId : crypto.randomUUID(),
    username,
    displayName: typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName : username,
    port: Number.isInteger(raw.port) && raw.port! > 0 && raw.port! < 65536 ? raw.port! : DEFAULT_PORT,
    autoAcceptFiles: raw.autoAcceptFiles === true,
    notifications: raw.notifications !== false,
    downloadsDir:
      typeof raw.downloadsDir === "string" && raw.downloadsDir
        ? raw.downloadsDir
        : path.join(paths.dataDir, "downloads"),
  };
  saveConfig(paths, config);
  return { config, created };
}

export function saveConfig(paths: Paths, config: Config): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const tmp = `${paths.configFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, paths.configFile);
}
