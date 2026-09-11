#!/bin/sh
# 共有ヘルパー。gw-start / gw-status / gw-stop / gw-restart から読み込む。
# 判断はすべてここと各スクリプトの中で完結させる。呼び出し側に条件分岐を持たせない。

set -eu

DTW_HOME="${DTW_HOME:-$HOME/.claude/discord-thread-workers}"
DTW_CONFIG="${DTW_CONFIG:-$DTW_HOME/config.json}"

die() {
  printf 'エラー: %s\n' "$1" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 が見つかりません。$2"
}

# 設定が無ければ雛形を書いて終わる。中身を確認してもらってから出直す。
ensure_config() {
  [ -f "$DTW_CONFIG" ] && return 0

  mkdir -p "$DTW_HOME"
  cat > "$DTW_CONFIG" <<EOF
{
  "workerRoots": ["$HOME/dev/src/github.com"],
  "pinToRepo": true,
  "gwName": "gw",
  "gwCwd": "$DTW_HOME/run",
  "channelPlugin": "plugin:discord@claude-plugins-official",
  "discordStateDir": "$HOME/.claude/channels/discord",
  "workerPermissionMode": "acceptEdits",
  "historyLimit": 50
}
EOF
  cat >&2 <<EOF
設定ファイルを作りました: $DTW_CONFIG

workerRoots を確認してください。先頭が worker を開く既定の場所になります。
リポジトリを束ねている親ディレクトリを指してください。
スレッド名の先頭がその下のリポジトリ名と一致したときは、そのリポジトリを直接開きます。

リポジトリを clone して開発する場合は "runtimePath" を足して、
そのチェックアウトの plugins/gw-runtime を指してください。
無ければインストール済みの gw-runtime を自動で使います。

確認したらもう一度実行してください。
EOF
  exit 1
}

# インストール済みの gw-runtime の場所を探す。
# 有効化されている必要はない。ファイルさえあれば --plugin-dir で渡せる。
resolve_runtime() {
  python3 - "$DTW_CONFIG" <<'PY'
import json, os, sys

cfg = {}
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
except Exception:
    pass

# 開発用の明示指定が最優先
override = cfg.get("runtimePath")
if override:
    print(os.path.abspath(os.path.expanduser(override)))
    raise SystemExit

reg = os.path.expanduser("~/.claude/plugins/installed_plugins.json")
try:
    with open(reg) as f:
        plugins = json.load(f).get("plugins", {})
except Exception:
    plugins = {}

best = None
for key, installs in plugins.items():
    if not key.startswith("gw-runtime@"):
        continue
    for i in installs:
        p = i.get("installPath")
        if p and os.path.isdir(p):
            # 同名が複数あれば新しい方を採る
            if best is None or (i.get("lastUpdated") or "") > best[0]:
                best = (i.get("lastUpdated") or "", p)
print(best[1] if best else "")
PY
}

# 設定を読んでシェル変数に展開する。
load_config() {
  ensure_config
  eval "$(
    python3 - "$DTW_CONFIG" <<'PY'
import json, os, shlex, sys

with open(sys.argv[1]) as f:
    c = json.load(f)

def path(v):
    return os.path.abspath(os.path.expanduser(str(v)))

out = {
    "CFG_GW_NAME": str(c.get("gwName", "gw")),
    "CFG_GW_CWD": path(c.get("gwCwd", "~/.claude/discord-thread-workers/run")),
    "CFG_CHANNEL": str(c.get("channelPlugin", "plugin:discord@claude-plugins-official")),
    "CFG_STATE_DIR": path(c.get("discordStateDir", "~/.claude/channels/discord")),
    "CFG_GW_PERMISSION_MODE": str(c.get("gwPermissionMode", "default")),
}
for k, v in out.items():
    print(f"{k}={shlex.quote(v)}")
PY
  )"

  CFG_RUNTIME=$(resolve_runtime)
  [ -n "$CFG_RUNTIME" ] || die "gw-runtime が見つかりません。
  /plugin install gw-runtime@discord-thread-workers を実行してください（有効化は不要です）。
  リポジトリから動かす場合は $DTW_CONFIG に \"runtimePath\" を書いてください。"

  CFG_RULES="$CFG_RUNTIME/prompts/relay-rules.md"
  CFG_SETTINGS=$(materialize_settings "$CFG_RUNTIME/config/gw-settings.json")
}

# GW の権限設定を組み立てる。
#
# 雛形（gw-settings.json）の deny はそのまま使い、defaultMode だけ
# config.json の gwPermissionMode で差し替えて $DTW_HOME に書き出す。
#
# なぜモードを変えられる必要があるか。
#
# セッション間のメッセージは、受け取る側のほうが権限モードが強いと
# 承認待ちで保留される。GW は既定で "default"、つまりいちばん弱い。
# worker を bypassPermissions で動かすと、GW から worker への受け渡しが
# そこで止まる。手元なら人が承認できるが、無人の環境では永久に止まる。
#
# deny の一覧はモードと独立に効くので、モードを上げても GW が
# Bash や Edit を使えるようにはならない。中継しかしないという性質は保たれる。
materialize_settings() {
  template=$1
  [ -f "$template" ] || die "権限設定の雛形が見つかりません: $template"

  if [ "${CFG_GW_PERMISSION_MODE:-default}" = "default" ]; then
    printf '%s' "$template"
    return
  fi

  out="$DTW_HOME/gw-settings.json"
  mkdir -p "$DTW_HOME"
  python3 - "$template" "$out" "$CFG_GW_PERMISSION_MODE" <<'PY'
import json, sys

template, out, mode = sys.argv[1], sys.argv[2], sys.argv[3]
with open(template) as f:
    settings = json.load(f)
settings.setdefault("permissions", {})["defaultMode"] = mode
with open(out, "w") as f:
    json.dump(settings, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
  printf '%s' "$out"
}

# 一覧の取得。ヒアドキュメントでスクリプトを渡すと標準入力がそちらに奪われるので、
# データはパイプではなく環境変数で渡す。
agents_json() {
  claude agents --json 2>/dev/null || printf '[]'
}

# 名前が一致する行を "state\tid\tsessionId\tcwd" で返す。
# state は running / stopped。見つからなければ何も出力しない。
agent_by_name() {
  AGENTS_JSON="$(agents_json)" python3 - "$1" <<'PY'
import json, os, sys

want = sys.argv[1]
try:
    rows = json.loads(os.environ.get("AGENTS_JSON") or "[]")
except Exception:
    sys.exit(0)
for a in rows if isinstance(rows, list) else []:
    if a.get("name") != want:
        continue
    state = "running" if a.get("pid") else "stopped"
    print("\t".join([state, str(a.get("id") or ""), str(a.get("sessionId") or ""), str(a.get("cwd") or "")]))
    break
PY
}

# 起動ログから channels の登録状況を判定する。ok / not-allowed / missing を返す。
channel_state() {
  GW_LOGS="$(claude logs "$1" 2>/dev/null | tr -d '\000' || true)" python3 <<'PY'
import os, re

txt = os.environ.get("GW_LOGS") or ""
txt = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\a]*\a", "", txt)
txt = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", txt)
if "not on the approved channels allowlist" in txt:
    print("not-allowed")
elif "inject directly in this session" in txt:
    print("ok")
else:
    print("missing")
PY
}
