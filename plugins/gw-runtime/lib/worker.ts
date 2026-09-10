// worker セッションの確保。スレッド ID が鍵で、セッション名がその写し。

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  cacheDrop,
  cacheRead,
  cacheWrite,
  config,
} from "./config.ts";
import { channelName, history } from "./discord.ts";
import {
  findByName,
  findBySessionId,
  isRunning,
  waitForRunning,
  workerName,
  type Agent,
} from "./agents.ts";

export type EnsureState =
  | "running"
  | "resumed"
  | "created"
  | "no_repo"
  | "error";

export type EnsureResult = {
  state: EnsureState;
  name: string;
  id?: string;
  cwd?: string;
  message?: string;
};

// スレッド名の先頭のかたまりをリポジトリ名として扱う。
// 「slides トレース章の見直し」「slides/トレース章」どちらでも slides を拾う。
function repoTokenOf(threadName: string): string | null {
  const t = threadName.trim().split(/[\s/:：、,　]+/u)[0];
  return t ? t : null;
}

function findRepo(token: string): string | null {
  for (const root of config().workerRoots) {
    if (!existsSync(root)) continue;

    const direct = join(root, token);
    if (existsSync(direct) && statSync(direct).isDirectory()) return direct;

    // 1 階層下も見る（~/dev/src/github.com/<owner>/<repo> のような並びのため）
    for (const owner of readdirSync(root)) {
      const nested = join(root, owner, token);
      try {
        if (statSync(nested).isDirectory()) return nested;
      } catch {
        /* 読めないものは飛ばす */
      }
    }
  }
  return null;
}

function seedPrompt(lines: { author: string; bot: boolean; text: string }[]): string {
  if (lines.length === 0) {
    return [
      "このセッションは Discord のスレッド 1 つを担当します。",
      "まだ依頼は届いていません。「待機中」とだけ返して、次のメッセージを待ってください。",
    ].join("\n");
  }

  const body = lines
    .map((l) => `${l.bot ? "あなた（過去の返信）" : l.author}: ${l.text}`)
    .join("\n");

  return [
    "このセッションは Discord のスレッド 1 つを担当します。",
    "以下はそのスレッドでこれまでに交わされた会話です。文脈として読むだけにして、",
    "まだ作業を始めないでください。実際の依頼は次のメッセージとして届きます。",
    "",
    "--- ここまでの会話 ---",
    body,
    "--- ここまで ---",
    "",
    "読み終えたら「文脈を読みました」とだけ返して待機してください。",
  ].join("\n");
}

async function spawnWorker(
  threadId: string,
  cwd: string,
  prompt: string,
): Promise<void> {
  const cfg = config();
  // worker のルールはこのプラグインに同梱されている。設定に場所を持たせない。
  const workerRules = join(import.meta.dir, "..", "prompts", "worker-rules.md");
  const p = Bun.spawn(
    [
      "claude",
      "--bg",
      "--name",
      workerName(threadId),
      "--append-system-prompt-file",
      workerRules,
      "--permission-mode",
      cfg.workerPermissionMode,
      prompt,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  await p.exited;
}

async function resumeWorker(threadId: string, sessionId: string): Promise<void> {
  const p = Bun.spawn(
    ["claude", "--bg", "--resume", sessionId, "--name", workerName(threadId)],
    { stdout: "pipe", stderr: "pipe" },
  );
  await p.exited;
}

async function afterStart(
  threadId: string,
  state: EnsureState,
  cwd: string,
): Promise<EnsureResult> {
  const name = workerName(threadId);
  const live = await waitForRunning(name);
  if (!live) {
    return {
      state: "error",
      name,
      message: `worker が起動しませんでした (${name})。claude agents で確認してください。`,
    };
  }
  if (live.sessionId) {
    cacheWrite(threadId, {
      sessionId: live.sessionId,
      cwd: live.cwd ?? cwd,
      createdAt: Date.now(),
    });
  }
  return { state, name, id: live.id, cwd: live.cwd ?? cwd };
}

export async function ensureWorker(threadId: string): Promise<EnsureResult> {
  const name = workerName(threadId);

  try {
    // 1. 生きている
    const live: Agent | null = await findByName(name);
    if (live && isRunning(live)) {
      return { state: "running", name, id: live.id, cwd: live.cwd };
    }

    // 2. 止まっているが会話は残っている → 同じ会話で再開する（作業の状態まで戻る）
    const stoppedSessionId =
      live?.sessionId ?? (await resumableFromCache(threadId));
    if (stoppedSessionId) {
      await resumeWorker(threadId, stoppedSessionId);
      const res = await afterStart(threadId, "resumed", live?.cwd ?? "");
      if (res.state !== "error") return res;
      cacheDrop(threadId); // 再開できなかった控えは捨てて新規に落とす
    }

    // 3. 新規に立てる。スレッド名からリポジトリを決め、履歴で文脈だけ復元する
    const tname = await channelName(threadId);
    const token = repoTokenOf(tname);
    const cwd = token ? findRepo(token) : null;
    if (!cwd) {
      return {
        state: "no_repo",
        name,
        message: token
          ? `リポジトリ ${token} が見つかりませんでした`
          : "スレッド名からリポジトリ名を読み取れませんでした",
      };
    }

    const lines = await history(threadId, config().historyLimit + 1);
    lines.pop(); // 引き金になった発言は履歴から外す。通常の経路で届くため
    await spawnWorker(threadId, cwd, seedPrompt(lines));
    return await afterStart(threadId, "created", cwd);
  } catch (e) {
    return { state: "error", name, message: String(e) };
  }
}

async function resumableFromCache(threadId: string): Promise<string | null> {
  const entry = cacheRead()[threadId];
  if (!entry?.sessionId) return null;
  // 台帳に痕跡が残っているものだけ再開を試す
  return (await findBySessionId(entry.sessionId)) ? entry.sessionId : null;
}
