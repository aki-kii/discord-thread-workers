#!/usr/bin/env bun
// 往路の検査。GW が worker へ渡す本文が、Discord から届いた原文と一字一句同じかを見る。
// 違えば拒否する。要約も加筆も分割も、ここで機械的に止まる。

import { deny, hasUnrelayed, pass, readTranscript, skip } from "./relay-log.ts";

const input = JSON.parse(await Bun.stdin.text());
const to = String(input?.tool_input?.to ?? "");

// スレッド宛でなければ中継ではない。通常のセッション間通信として通す。
const m = /^thread-(\d+)$/.exec(to);
if (!m) pass();

const threadId = m[1]!;
const message = input?.tool_input?.message ?? input?.tool_input?.content;
if (typeof message !== "string") {
  deny("message が文字列ではありません。届いた本文をそのまま渡してください。");
}

const path = input?.transcript_path;
if (typeof path !== "string") skip("transcript_path が渡されませんでした");

let bundle;
try {
  bundle = readTranscript(path, "channel", "SendMessage", ["message", "content"]);
} catch (e) {
  skip(String(e));
}

if (bundle.inbound.length === 0) {
  skip("Discord から届いた本文が会話ログに見つかりませんでした");
}

if (hasUnrelayed(bundle, threadId, message)) pass();

const latest = [...bundle.inbound].reverse().find((i) => i.threadId === threadId);
deny(
  [
    `スレッド ${threadId} から届いた本文と一致しません。`,
    "worker には届いた本文を一字一句そのまま渡してください。",
    "要約・言い換え・整形・分割・前置きの追加はできません。",
    latest
      ? `渡すべき本文（先頭 120 文字）: ${latest.body.slice(0, 120)}`
      : "このスレッドから届いた本文が見つかりません。宛先のスレッド ID が正しいか確認してください。",
  ].join("\n"),
);
