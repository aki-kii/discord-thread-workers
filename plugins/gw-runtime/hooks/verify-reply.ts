#!/usr/bin/env bun
// 復路の検査。GW が Discord へ投稿する本文が、worker から届いた原文と一字一句同じかを見る。
// 例外は定型文だけ。GW が自分の言葉で Discord に書くことはできない。

import { deny, hasUnrelayed, pass, readTranscript, skip } from "./relay-log.ts";

const TEMPLATES = [
  "worker を置く場所が設定されていません。config.json の workerRoots を確認してください。",
  "worker が停止しています。次のメッセージで起動し直します。",
];
const TEMPLATE_PREFIXES = ["worker を用意できませんでした:"];

const input = JSON.parse(await Bun.stdin.text());
const chatId = String(input?.tool_input?.chat_id ?? "");
const text = input?.tool_input?.text;

if (typeof text !== "string") {
  deny("text が文字列ではありません。届いた本文をそのまま渡してください。");
}

if (TEMPLATES.includes(text) || TEMPLATE_PREFIXES.some((p) => text.startsWith(p))) {
  pass();
}

const path = input?.transcript_path;
if (typeof path !== "string") skip("transcript_path が渡されませんでした");

let bundle;
try {
  bundle = readTranscript(
    path,
    "peer",
    "mcp__plugin_discord_discord__reply",
    ["text"],
  );
} catch (e) {
  skip(String(e));
}

if (bundle.inbound.length === 0) {
  skip("worker から届いた本文が会話ログに見つかりませんでした");
}

if (hasUnrelayed(bundle, chatId, text)) pass();

const latest = [...bundle.inbound].reverse().find((i) => i.threadId === chatId);
deny(
  [
    `worker から届いた本文と一致しません（スレッド ${chatId}）。`,
    "届いた本文を一字一句そのまま text に渡してください。",
    "2000 文字を超えても分割しないでください。分割は Discord プラグインが行います。",
    latest
      ? `渡すべき本文（先頭 120 文字）: ${latest.body.slice(0, 120)}`
      : "このスレッドを担当する worker からの本文が見つかりません。from-name のスレッド ID を確認してください。",
  ].join("\n"),
);
