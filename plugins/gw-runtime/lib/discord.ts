// Discord REST を直接叩く。Gateway 接続は持たない。
// 使うのは 2 つだけ: スレッド名を引く（cwd の決定に使う）と、履歴を引く（新規 worker の文脈復元に使う）。

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

export async function channelName(channelId: string): Promise<string> {
  const ch = await api(`/channels/${channelId}`);
  return String(ch.name ?? "");
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
