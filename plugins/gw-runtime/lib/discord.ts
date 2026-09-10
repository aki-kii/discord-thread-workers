// Discord REST を直接叩く。Gateway 接続は持たない。
// 使うのは 3 つだけ: チャンネルを引く（スレッドかどうかの判定と cwd の決定に使う）、
// スレッドが閉じているかを見る（閉じた worker の片付けに使う）、
// 履歴を引く（新規 worker の文脈復元に使う）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

const API = "https://discord.com/api/v10";

let token: string | null = null;

function botToken(): string {
  if (token) return token;

  const fromEnv = process.env.DISCORD_BOT_TOKEN;
  if (fromEnv) return (token = fromEnv);

  // 公式 Discord プラグインが書いた .env を読む。トークンの管理は一箇所に保つ。
  const envFile = join(config().discordStateDir, ".env");
  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith("DISCORD_BOT_TOKEN="));
  if (!line) throw new Error(`DISCORD_BOT_TOKEN が見つかりません: ${envFile}`);

  return (token = line.slice("DISCORD_BOT_TOKEN=".length).trim());
}

async function api(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bot ${botToken()}` },
  });
  if (!res.ok) {
    throw new Error(`Discord API ${res.status}: ${path} ${await res.text()}`);
  }
  return res.json();
}

// スレッドのチャンネル種別。10 = アナウンス、11 = 公開、12 = 非公開。
// これ以外は通常のチャンネルで、worker の担当単位にはならない。
const THREAD_TYPES = new Set([10, 11, 12]);

export type ChannelInfo = { name: string; isThread: boolean };

export async function channelInfo(channelId: string): Promise<ChannelInfo> {
  const ch = await api(`/channels/${channelId}`);
  return {
    name: String(ch.name ?? ""),
    isThread: THREAD_TYPES.has(Number(ch.type)),
  };
}

// スレッドが閉じているか。
//
// Discord の「クローズ」はアーカイブのこと。チャンネルを引くと
// thread_metadata.archived に出る。消されたスレッドは 404 になるので、
// 引けなかったこと自体を gone として返す。
//
// unknown は「判断がつかない」。ネットワークや権限の失敗をアーカイブと
// 取り違えて worker を止めてしまわないよう、明示的に分けている。
export type ThreadState = "open" | "archived" | "gone" | "unknown";

export async function threadState(channelId: string): Promise<ThreadState> {
  const res = await fetch(`${API}/channels/${channelId}`, {
    headers: { authorization: `Bot ${botToken()}` },
  });

  if (res.status === 404) return "gone";
  if (!res.ok) return "unknown";

  try {
    const ch: any = await res.json();
    if (!ch?.thread_metadata) return "open"; // スレッドでないなら閉じようがない
    return ch.thread_metadata.archived ? "archived" : "open";
  } catch {
    return "unknown";
  }
}

export type HistoryLine = { author: string; bot: boolean; text: string };

// 古い順に返す。呼び出し側が引き金になった 1 件を落とす。
export async function history(
  channelId: string,
  limit: number,
): Promise<HistoryLine[]> {
  const capped = Math.max(1, Math.min(100, limit));
  const msgs = await api(`/channels/${channelId}/messages?limit=${capped}`);

  return (Array.isArray(msgs) ? msgs : [])
    .reverse()
    .map((m: any) => ({
      author: String(m.author?.username ?? "unknown"),
      bot: Boolean(m.author?.bot),
      text: String(m.content ?? "") +
        (m.attachments?.length ? `　(添付 ${m.attachments.length} 件)` : ""),
    }))
    .filter((l: HistoryLine) => l.text.trim().length > 0);
}
