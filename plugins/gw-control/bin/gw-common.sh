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

# 端末向けの装飾を落として素のテキストにする。
# claude の出力には色や制御文字が混ざる。付いたまま切り出しや照合をすると黙って外れる。
strip_ansi() {
  python3 -c '
import re, sys
txt = sys.stdin.buffer.read().decode("utf-8", "replace")
txt = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\a]*\a", "", txt)
sys.stdout.write(re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", txt))
'
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
  CFG_SETTINGS="$CFG_RUNTIME/config/gw-settings.json"
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
  _logs=$(claude logs "$1" 2>/dev/null | strip_ansi || true)
  case "$_logs" in
    *"not on the approved channels allowlist"*) printf 'not-allowed\n' ;;
    *"inject directly in this session"*) printf 'ok\n' ;;
    *) printf 'missing\n' ;;
  esac
}
