// 閉じたスレッドの worker を止める掃除。
//
// Discord は「スレッドを閉じた」を知らせてこない。公式プラグインが購読しているのは
// メッセージだけで、THREAD_UPDATE はセッションまで届かない。そこで、どこかのスレッドに
// 発言が届いたついでに、生きている worker のスレッドをまとめて引き直して確かめる。
// 新しい認証も常駐も増やさない代わりに、掃除は「誰かが話しかけたとき」にだけ走る。
//
// 止めても会話は残る。閉じたスレッドが開き直されて発言が届けば、同じ会話で再開する。
// つまり掃除しすぎても失われるものはなく、遅れても困らない。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DTW_HOME, cacheDrop, config } from "./config.ts";
import {
  isRunning,
  listAgents,
  stopAgent,
  threadIdOf,
  type Agent,
} from "./agents.ts";
import { threadState } from "./discord.ts";

const STAMP_PATH = join(DTW_HOME, "reap.json");

function lastRunAt(): number {
  try {
    return Number(JSON.parse(readFileSync(STAMP_PATH, "utf8")).lastRunAt ?? 0);
  } catch {
    return 0;
  }
}

function markRun(at: number): void {
  mkdirSync(DTW_HOME, { recursive: true });
  writeFileSync(STAMP_PATH, JSON.stringify({ lastRunAt: at }, null, 2));
}

export type Stopped = {
  thread_id: string;
  name: string;
  reason: "archived" | "gone" | "duplicate";
};

export type ReapResult = {
  state: "reaped" | "skipped";
  checked: number;
  stopped: Stopped[];
  next_in_minutes?: number;
};

export async function reapWorkers(force = false): Promise<ReapResult> {
  const now = Date.now();
  const intervalMs = Math.max(0, config().reapIntervalMinutes) * 60_000;
  const elapsed = now - lastRunAt();

  if (!force && elapsed < intervalMs) {
    return {
      state: "skipped",
      checked: 0,
      stopped: [],
      next_in_minutes: Math.ceil((intervalMs - elapsed) / 60_000),
    };
  }

  // 走る前に印を付ける。途中で落ちても、次の発言のたびに掃除が走り直すことはない。
  markRun(now);

  const workers = (await listAgents()).filter(
    (a) => threadIdOf(a.name) && isRunning(a),
  );

  const stopped: Stopped[] = [];
  const kept: Agent[] = [];
  for (const a of workers) {
    const threadId = threadIdOf(a.name)!;
    // 引けなかったときは unknown が返る。分からないものは触らない。
    const state = await threadState(threadId);
    if (state !== "archived" && state !== "gone") {
      kept.push(a);
      continue;
    }

    await stopAgent(a.id);
    if (state === "gone") cacheDrop(threadId); // スレッドごと消えた。再開先はもうない
    stopped.push({ thread_id: threadId, name: a.name!, reason: state });
  }

  // 同じスレッドに worker が何個も走っていたら、新しい 1 つだけ残す。
  //
  // 台帳の古い行を掴んで立て直しに落ちると、話しかけるたびに 1 つ増える。増えた分は
  // どれも同じスレッドを担当しているので、放っておくと同じ問いかけに何人もが返事をする。
  // 残すのを新しい方にするのは、中継が次に掴むのも新しい方だから。
  for (const [name, rows] of groupByName(kept)) {
    if (rows.length < 2) continue;
    rows.sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0));
    for (const a of rows.slice(1)) {
      await stopAgent(a.id);
      stopped.push({ thread_id: threadIdOf(name)!, name, reason: "duplicate" });
    }
  }

  return { state: "reaped", checked: workers.length, stopped };
}

function groupByName(rows: Agent[]): Map<string, Agent[]> {
  const byName = new Map<string, Agent[]>();
  for (const a of rows) {
    const name = a.name!;
    const group = byName.get(name);
    if (group) group.push(a);
    else byName.set(name, [a]);
  }
  return byName;
}
