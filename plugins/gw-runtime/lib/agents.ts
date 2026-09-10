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

export async function findByName(name: string): Promise<Agent | null> {
  const rows = await listAgents();
  return rows.find((a) => a.name === name) ?? null;
}

export async function findBySessionId(sessionId: string): Promise<Agent | null> {
  const rows = await listAgents();
  return rows.find((a) => a.sessionId === sessionId) ?? null;
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
