# discord-thread-workers

Discord のスレッド 1 本に、Claude Code のセッション 1 つを割り当てる。
スレッドで話しかけると、そのリポジトリで動く worker が立ち上がって返事をする。

Claude Code Channels 本体と公式 Discord プラグインには手を入れない。
足りない部分だけを外から足している。

```
Discord のスレッド ──▶ 公式 Discord プラグイン ──▶ GW ──▶ worker（実リポジトリ）
        ▲                                            │
        └──────────── reply ◀────── SendMessage ◀────┘
```

GW（Gateway セッション）は中継だけをする。届いた本文を一言一句そのまま worker に渡し、
返ってきた本文を一言一句そのままスレッドへ返す。要約も加筆も分割もしない。
これはルールとしてだけでなく、フックで機械的に強制している。

## 仕組みの要点

| | |
| --- | --- |
| スレッドと worker の対応 | セッション名を `thread-<スレッドID>` に固定する。対応表は持たない |
| worker の台帳 | `claude agents --json` が唯一の真実。停止・稼働・作業ディレクトリが取れる |
| 復路の宛先 | 届いたメッセージの `from-name` にスレッド ID が入っている。GW は何も覚えない |
| worker の置き場所 | `claude --bg`。tmux は使わない |
| GW の置き場所 | 同じく `claude --bg`。ターミナルを占有しない |
| GW の権限 | ファイル読み書きもコマンド実行も禁止。中継に必要なツールだけ許可 |

## 必要なもの

- Claude Code（Channels はリサーチプレビュー。Pro / Max なら追加設定は不要）
- [Bun](https://bun.sh) — channel プラグインと本プラグインの MCP サーバーが使う
- 公式 Discord プラグインの設定が済んでいること（`/discord:configure <トークン>`）

## 導入

### 1. プラグインを入れる

```
/plugin marketplace add aki-kii/discord-thread-workers
/plugin install gw-control@discord-thread-workers
/plugin install gw-runtime@discord-thread-workers
```

**`gw-runtime` は有効化しない。** インストールしてファイルを置くだけでよく、
`gw-control` が GW を起動するときに `--plugin-dir` でそのセッションにだけ読み込む。
有効化してしまうと、普段のセッションにも MCP サーバーとフックが載る。

### 2. Discord 側を用意する

worker 用のスレッドをぶら下げる親チャンネルを 1 つ作り、受信を許可する。

```
/discord:access group add <親チャンネルID> --no-mention
```

公式プラグインの受信判定はスレッドではなく**親チャンネル**で行われるので、
親を 1 つ許可すれば配下のスレッドはすべて通る。`--no-mention` を付けないと、
スレッドで話すたびにボットをメンションしないと届かない。

親チャンネル直下の発言も同じ経路で GW に届くが、そちらには worker を立てず、
返信もしない。担当の単位はスレッドだけで、チャンネルは待ち合わせ場所として空けておく。

### 3. 設定を書く

初回に `gw-control` のスキルを呼ぶと `~/.claude/discord-thread-workers/config.json` の
雛形ができる。`workerRoots` だけ確認すればよい。

```json
{
  "workerRoots": ["/Users/you/dev/src/github.com/you"],
  "pinToRepo": true,
  "gwName": "gw",
  "gwCwd": "/Users/you/.claude/discord-thread-workers/run",
  "channelPlugin": "plugin:discord@claude-plugins-official",
  "discordStateDir": "/Users/you/.claude/channels/discord",
  "workerPermissionMode": "acceptEdits",
  "historyLimit": 50
}
```

### 無人で動かすとき

手元で使うぶんには既定のままでよい。worker が権限を聞いてきたら、あなたが
答えればいい。

**答える人がいない環境に置く場合は、2 つ変える必要がある。**

```json
{
  "workerPermissionMode": "bypassPermissions",
  "gwPermissionMode": "bypassPermissions"
}
```

worker のほうは分かりやすい。`acceptEdits` のままだと、最初のコマンドで
承認待ちのまま固まる。誰も答えないので永久に止まる。

**GW のほうも一緒に上げないといけない**のが分かりにくいところ。
セッション間のメッセージは、**受け取る側のほうが権限モードが強いと
承認待ちで保留される**。GW は既定で `default`、つまりいちばん弱いので、
worker だけ上げると GW から worker への受け渡しがそこで止まる。
症状は「bot が反応する（書き込み中が出る）のに返事が来ない」。

GW のモードを上げても、**GW が Bash や Edit を使えるようにはならない**。
`gw-settings.json` の `deny` はモードと独立に効くので、中継しかしないという
性質は保たれる。上がるのは「送り先より弱い」という状態だけ。

`workerRoots` の先頭が、worker を開く既定の場所になる。**リポジトリを束ねている
親ディレクトリ**を指すとよい。ホームディレクトリでも動くが、鍵や設定まで範囲に
入るので勧めない。

`pinToRepo` が真（既定）のとき、スレッド名の先頭がその下のリポジトリ名と一致すれば、
そのリポジトリを直接開く。一致しなければ親ディレクトリで開く。**どちらでも失敗しない。**

リポジトリまで降りるかどうかで違うのは 1 点だけ。そのリポジトリの
`.claude/settings.json` とプロジェクト設定は、**cwd がそのリポジトリのときだけ**読まれる。
`CLAUDE.md` は下の階層のものも、Claude がそのディレクトリのファイルを読んだ時点で
自動的に読み込まれるので、親で開いても効く。常に親で開きたければ `pinToRepo` を偽にする。

リポジトリを clone して開発する場合は `"runtimePath"` を足し、
そのチェックアウトの `plugins/gw-runtime` を指す。

### 4. GW を立てる

普段のセッションで `/gw-control:start`。あるいは端末から直接:

```sh
~/.claude/plugins/cache/discord-thread-workers/gw-control/*/bin/gw-start
```

何度実行しても安全で、すでに動いていれば何もしない。

## 使い方

親チャンネルにスレッドを切って話しかける。最初の発言で worker が起動し、
以降そのスレッドはその仕事専任の会話になる。別の仕事は別のスレッドを切る。

```
slides  トレース章の図を差し替えたい
```

スレッド名の先頭をリポジトリ名にしておくと、worker がそのリポジトリで直接開く。
そうでなくても親ディレクトリで開くので、その下のリポジトリはすべて触れる。

| したいこと | |
| --- | --- |
| 状態を見る | `/gw-control:status` |
| GW を止める | `/gw-control:stop`（worker も止めるなら `--workers`） |
| GW を入れ直す | `/gw-control:restart` |
| worker の中を見る | `claude attach <id>` |
| 全部を今のバージョンで立て直す | `claude respawn --all` |

GW を止めても worker は生き続ける。GW を立て直せばそのまま繋がる。

## worker が落ちたら

復帰は二段構え。

1. 会話が残っていれば**同じ会話のまま再開**する。作業の状態まで戻る
2. 会話ごと消えている場合は新規に立て、**スレッドの履歴を読ませて**文脈だけ復元する

どちらも自動で選ばれる。手で何かする必要はない。

## 権限について

worker は端末に繋がっていないので、権限の確認ダイアログに答えられる人がいない。
そのため `workerPermissionMode`（既定は `acceptEdits`）で事前に方針を決め、
判断が要ることは worker が**文章でスレッドに聞く**運用にしている。

危険な操作を機械的に塞ぎたい場合は `permissions.deny` を書く。ただし置き場所に注意。
リポジトリの `.claude/settings.json` は、**worker がそのリポジトリを cwd として開いた
ときにしか読まれない**。親ディレクトリで開いた worker には効かない。

どこで開いても効かせたいものは、ユーザー設定（`~/.claude/settings.json`）に書く。
リポジトリ固有のものは、スレッド名の先頭にリポジトリ名を入れて `pinToRepo` に
拾わせる（既定で有効）。

## 構成

```
plugins/gw-control/     有効化して使う。スキルと、判断を全部持つスクリプト
plugins/gw-runtime/     GW にだけ読み込む。MCP サーバー、フック、GW と worker のルール
```

`gw-control/bin/*` はスキルからも端末からも launchd からも同じものが動く。
点検・起動・確認はすべてスクリプトの中にあり、スキルは「実行して出力を見せる」だけ。

## 既知の制約

- GW が止まっている間に届いたメッセージは失われる。復帰時に拾い直す仕組みは未実装
- スレッドの自動アーカイブは作成時に最長（7 日）を選んでおくとよい
- 同じリポジトリに複数のスレッドを切ると、worker 同士が同じ作業ディレクトリで衝突する。
  スレッドごとに worktree を切る対応は未実装
- 逐語検査は会話ログを読んで突き合わせている。ログを読めなかった場合は中継を止めず、
  検査を飛ばしたことだけを伝える

## ライセンス

MIT
