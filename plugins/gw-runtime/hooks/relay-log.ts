// 会話ログ（transcript）から、中継すべき原文と、すでに中継した本文を取り出す。
//
// 届いたものは 2 つの形で記録される。手が空いているときに届くと `type: "user"` の
// 行に本文がタグごと入り、作業中に届いて順番待ちになると `type: "attachment"` の
// 行に入る（こちらは本文が origin にほぐれて入っている）。どちらも見る。
//
// 送ったものは `type: "assistant"` の tool_use から拾う。どれも本文が原形のまま
// 入っているので、突き合わせは単純な文字列比較で済む。ただし tool_use にあるのは
// 「送ろうとした」記録でしかない。検査中の呼び出し自身もそこに並ぶし、この hook が
// 拒んだ試行も残る。どちらも届いてはいないので、tool_result まで見て振り落とす。

import { readFileSync } from "node:fs";

export type Inbound = { threadId: string; body: string };

type Bundle = { inbound: Inbound[]; sent: string[] };

const CHANNEL_RE =
  /<channel\s+[^>]*chat_id="(\d+)"[^>]*>\n([\s\S]*)\n<\/channel>/;

const PEER_RE =
  /<cross-session-message\s+[^>]*from-name="thread-(\d+)"[^>]*>\n([\s\S]*)\n<\/cross-session-message>/;

function fromText(text: string, kind: "channel" | "peer"): Inbound | null {
  const m = (kind === "channel" ? CHANNEL_RE : PEER_RE).exec(text);
  return m ? { threadId: m[1]!, body: m[2]! } : null;
}

export function readTranscript(
  path: string,
  kind: "channel" | "peer",
  sentToolName: string,
  sentFields: string[],
): Bundle {
  const inbound: Inbound[] = [];
  const attempts: { id: string; body: string }[] = [];
  const delivered = new Set<string>();

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;

    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row.type === "user") {
      // 手が空いているときに届いたもの
      if (typeof row.message?.content === "string") {
        const hit = fromText(row.message.content, kind);
        if (hit) inbound.push(hit);
        continue;
      }

      // 送ろうとしたものの結果。エラーで返ったものは届いていない。
      if (Array.isArray(row.message?.content)) {
        for (const block of row.message.content) {
          if (block?.type !== "tool_result") continue;
          const id = String(block.tool_use_id ?? "");
          if (id && block.is_error !== true) delivered.add(id);
        }
      }
      continue;
    }

    // 作業中に届いて順番待ちになったもの
    if (row.type === "attachment") {
      const att = row.attachment;
      if (att?.type !== "queued_command") continue;
      if (att.origin?.kind !== kind) continue;

      if (kind === "peer") {
        const m = /^thread-(\d+)$/.exec(String(att.origin.name ?? ""));
        if (m && typeof att.origin.body === "string") {
          inbound.push({ threadId: m[1]!, body: att.origin.body });
          continue;
        }
      }
      const hit = fromText(String(att.prompt ?? ""), kind);
      if (hit) inbound.push(hit);
      continue;
    }

    // 送ろうとしたもの
    if (row.type === "assistant" && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        if (block?.type !== "tool_use" || block.name !== sentToolName) continue;
        for (const f of sentFields) {
          const v = block.input?.[f];
          if (typeof v === "string") {
            attempts.push({ id: String(block.id ?? ""), body: v });
            break;
          }
        }
      }
    }
  }

  // 結果が返っていて、それがエラーでないものだけが「送った」。
  // 検査中の呼び出しは結果がまだ無いので、ここで自然に落ちる。
  const sent = attempts.filter((a) => delivered.has(a.id)).map((a) => a.body);

  return { inbound, sent };
}

// 同じ本文が複数回届くこともある。届いた回数より送った回数が少ない間だけ通す。
export function hasUnrelayed(
  bundle: Bundle,
  threadId: string,
  body: string,
): boolean {
  const arrived = bundle.inbound.filter(
    (i) => i.threadId === threadId && i.body === body,
  ).length;
  if (arrived === 0) return false;

  const relayed = bundle.sent.filter((s) => s === body).length;
  return relayed < arrived;
}

export function deny(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// 検査できなかったときは止めない。中継そのものが止まるほうが困る。
// ただし検査していないことは伝える。
export function skip(note: string): never {
  console.log(
    JSON.stringify({ systemMessage: `中継の逐語検査を飛ばしました: ${note}` }),
  );
  process.exit(0);
}

export function pass(): never {
  process.exit(0);
}
