---
name: stop
description: Discord スレッド中継の GW セッションを止める。「GW を止めて」「Discord の中継を停止」などのときに使う。worker も止めたい場合は --workers を付ける。
---

`${CLAUDE_PLUGIN_ROOT}/bin/gw-stop` を実行し、**出力をそのまま利用者に見せてください。**

利用者が worker も止めたいと明示した場合だけ、引数に `--workers` を付けます。
明示がなければ付けません。GW を止めても worker は生き続け、GW を立て直せばそのまま繋がります。
