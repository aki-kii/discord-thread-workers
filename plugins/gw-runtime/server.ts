#!/usr/bin/env bun
// GW セッションにだけ載る MCP サーバー。
// Discord への Gateway 接続は持たない。トークンを読むのはスレッド名と履歴を引くためだけ。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  isRunning,
  listAgents,
  stopAgent,
  threadIdOf,
  waitForRunning,
  workerName,
} from "./lib/agents.ts";
import { ensureWorker } from "./lib/worker.ts";
import { cacheDrop } from "./lib/config.ts";

const server = new McpServer(
  { name: "gw-runtime", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: [
      "Discord のスレッドと worker セッションを対応させるツール群です。",
      "スレッド ID が鍵で、worker のセッション名は thread-<スレッドID> になります。",
      "スレッドからメッセージが届いたら ensure_worker を呼び、返ってきた name 宛に",
      "SendMessage で本文をそのまま渡してください。対応表はどこにもありません。",
      "スレッドではないチャンネルの発言には state: not_a_thread が返ります。",
      "そのときは何も中継せず、Discord にも返信しないでください。",
    ].join("\n"),
  },
);

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

server.registerTool(
  "ensure_worker",
  {
    description:
      "スレッド ID に対応する worker セッションを用意し、宛先の名前を返す。" +
      "動いていればそのまま、止まっていれば同じ会話で再開、無ければスレッド名から" +
      "リポジトリを決めて新規に立て、そのスレッドの履歴を文脈として読ませる。" +
      "スレッドではないチャンネルの ID を渡した場合は worker を立てず not_a_thread を返す。",
    inputSchema: {
      thread_id: z
        .string()
        .regex(/^\d+$/, "スレッド ID は数字のみ")
        .describe("Discord のスレッド ID。届いた通知の chat_id をそのまま渡す"),
    },
  },
  async ({ thread_id }) => {
    const r = await ensureWorker(thread_id);
    return text(
      JSON.stringify(
        {
          state: r.state,
          name: r.name,
          id: r.id ?? null,
          cwd: r.cwd ?? null,
          message: r.message ?? null,
        },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "list_workers",
  {
    description:
      "稼働中の worker セッションの一覧。スレッド ID、作業ディレクトリ、状態を返す。",
    inputSchema: {},
  },
  async () => {
    const rows = (await listAgents())
      .filter((a) => threadIdOf(a.name))
      .map((a) => ({
        thread_id: threadIdOf(a.name),
        name: a.name,
        id: a.id,
        cwd: a.cwd ?? null,
        state: isRunning(a) ? (a.status ?? "running") : "stopped",
        started_at: a.startedAt ?? null,
      }));
    return text(JSON.stringify(rows, null, 2));
  },
);

server.registerTool(
  "stop_worker",
  {
    description:
      "worker セッションを止める。会話は残るので、次に呼ばれたときは同じ会話で再開される。",
    inputSchema: {
      thread_id: z.string().regex(/^\d+$/).describe("Discord のスレッド ID"),
    },
  },
  async ({ thread_id }) => {
    const name = workerName(thread_id);
    const a = (await listAgents()).find((x) => x.name === name);
    if (!a) return text(JSON.stringify({ state: "absent", name }));
    if (!isRunning(a)) return text(JSON.stringify({ state: "already_stopped", name }));
    await stopAgent(a.id);
    return text(JSON.stringify({ state: "stopped", name, id: a.id }));
  },
);

server.registerTool(
  "restart_worker",
  {
    description:
      "応答しなくなった worker を止めて立て直す。会話は引き継がず、スレッドの履歴から文脈だけ復元する。",
    inputSchema: {
      thread_id: z.string().regex(/^\d+$/).describe("Discord のスレッド ID"),
    },
  },
  async ({ thread_id }) => {
    const name = workerName(thread_id);
    const a = (await listAgents()).find((x) => x.name === name);
    if (a && isRunning(a)) {
      await stopAgent(a.id);
      await waitForRunning(name, 3_000);
    }
    cacheDrop(thread_id); // 再開ではなく新規に落とす
    const r = await ensureWorker(thread_id);
    return text(JSON.stringify({ state: r.state, name: r.name, cwd: r.cwd ?? null, message: r.message ?? null }, null, 2));
  },
);

await server.connect(new StdioServerTransport());
