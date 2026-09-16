// `claude agents --json` が worker の生きた台帳。ここ以外に状態を持たない。

export type Agent = {
  id: string;
  name?: string;
  cwd?: string;
  kind?: string;
  pid?: number | null;
  status?: string | null;
  state?: string | null;
  sessionId?: string;
  startedAt?: number;
};

export async function listAgents(): Promise<Agent[]> {
  const p = Bun.spawn(["claude", "agents", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  try {
    const rows = JSON.parse(out);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function workerName(threadId: string): string {
  return `thread-${threadId}`;
}

export function threadIdOf(name: string | undefined): string | null {
  const m = /^thread-(\d+)$/.exec(name ?? "");
  return m ? m[1]! : null;
}

export const isRunning = (a: Agent): boolean => Boolean(a.pid);

// 台帳は同じ name の行を消さずに溜める。死んだ行が先に並んでいると、素直に
// 先頭を取る書き方では生きている worker を見落とし、毎回立て直しに落ちる。
// 待ち受けも同じ行しか見ないので、新しく立てた worker が実際に走っていても
// 待ち切れて error になる。走っている行を先に、同じなら新しい行を選ぶ。
function pickLive(rows: Agent[]): Agent | null {
  let best: Agent | null = null;
  for (const a of rows) {
    if (!best || preferable(a, best)) best = a;
  }
  return best;
}

function preferable(a: Agent, over: Agent): boolean {
  if (isRunning(a) !== isRunning(over)) return isRunning(a);
  return (a.startedAt ?? 0) > (over.startedAt ?? 0);
}

export async function findByName(name: string): Promise<Agent | null> {
  return pickLive((await listAgents()).filter((a) => a.name === name));
}

export async function findBySessionId(sessionId: string): Promise<Agent | null> {
  return pickLive((await listAgents()).filter((a) => a.sessionId === sessionId));
}

// 起動直後は台帳に載るまで少し間がある。載って走り出すまで待つ。
export async function waitForRunning(
  name: string,
  timeoutMs = 20_000,
): Promise<Agent | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const a = await findByName(name);
    if (a && isRunning(a)) return a;
    await Bun.sleep(700);
  }
  return null;
}

export async function stopAgent(id: string): Promise<void> {
  const p = Bun.spawn(["claude", "stop", id], { stdout: "pipe", stderr: "pipe" });
  await p.exited;
}
