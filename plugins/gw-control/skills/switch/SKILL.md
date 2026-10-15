---
name: switch
description: Discord スレッド中継の GW と worker を、このセッションのアカウントへ移す。「アカウントを切り替えて」「こっちのアカウントで GW を動かして」、片方のアカウントがレートリミットに当たったときなどに使う。
---

`${CLAUDE_PLUGIN_ROOT}/bin/gw-switch` を実行し、**出力をそのまま利用者に見せてください。**

引数は取りません。切り替え先は、このセッションを起動したときの `CLAUDE_CONFIG_DIR` で決まります。
`CLAUDE_CONFIG_DIR` を自分で書き換えたり付け足したりして実行しないでください。
