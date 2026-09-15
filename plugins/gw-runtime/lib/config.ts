import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type Config = {
  gwName: string;
  gwCwd: string;
  channelPlugin: string;
  discordStateDir: string;
  workerRoots: string[];
  workerPermissionMode: string;
  historyLimit: number;
  pinToRepo: boolean;
  reapIntervalMinutes: number;
};

export const DTW_HOME =
  process.env.DTW_HOME ?? join(homedir(), ".claude", "discord-thread-workers");

const CONFIG_PATH = process.env.DTW_CONFIG ?? join(DTW_HOME, "config.json");

function expand(p: string): string {
  const s = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(s) ? s : resolve(s);
}

let cached: Config | null = null;

export function config(): Config {
  if (cached) return cached;

  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  cached = {
    gwName: String(raw.gwName ?? "gw"),
    gwCwd: expand(raw.gwCwd ?? join(DTW_HOME, "run")),
    channelPlugin: String(
      raw.channelPlugin ?? "plugin:discord@claude-plugins-official",
    ),
    discordStateDir: expand(
      raw.discordStateDir ?? join(homedir(), ".claude", "channels", "discord"),
    ),
    workerRoots: (raw.workerRoots ?? []).map((r: string) => expand(r)),
    workerPermissionMode: String(raw.workerPermissionMode ?? "auto"),
    historyLimit: Number(raw.historyLimit ?? 50),
    pinToRepo: raw.pinToRepo !== false,
    reapIntervalMinutes: Number(raw.reapIntervalMinutes ?? 60),
  };
  return cached;
}

// スレッド ID からセッション ID への控え。
//
// これは台帳ではなくキャッシュ。`claude agents --json` が生きた真実で、停止した
// セッションから name が落ちる場合にだけここを見る。失われても、新規に立てて
// 履歴から文脈を復元する経路に落ちるだけで壊れない。
const CACHE_PATH = join(DTW_HOME, "workers.json");

type CacheEntry = { sessionId: string; cwd: string; createdAt: number };

export function cacheRead(): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function cacheWrite(threadId: string, entry: CacheEntry): void {
  const all = cacheRead();
  all[threadId] = entry;
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(all, null, 2));
}

export function cacheDrop(threadId: string): void {
  const all = cacheRead();
  if (!(threadId in all)) return;
  delete all[threadId];
  writeFileSync(CACHE_PATH, JSON.stringify(all, null, 2));
}
