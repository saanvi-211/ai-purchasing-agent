import type { Scenario, WorldState, TraceEvent, EvaluationReport } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  getState: () => fetch('/api/state').then((r) => json<WorldState>(r)),
  getScenarios: () => fetch('/api/scenarios').then((r) => json<Scenario[]>(r)),
  getLlmInfo: () => fetch('/api/llm').then((r) => json<{ configured: boolean; base_url: string; model: string }>(r)),
  reset: () => fetch('/api/reset', { method: 'POST' }).then((r) => json<{ ok: boolean }>(r)),
  approve: (poId: string) => fetch(`/api/approvals/${poId}/approve`, { method: 'POST' }).then((r) => json<any>(r)),
  reject: (poId: string) => fetch(`/api/approvals/${poId}/reject`, { method: 'POST' }).then((r) => json<any>(r)),
  runEvaluation: () => fetch('/api/evaluation/run').then((r) => json<EvaluationReport>(r)),
};

// Stream an agent run over SSE, delivering each trace event to onEvent.
export function runAgentStream(
  scenarioId: string,
  brain: string,
  onEvent: (e: TraceEvent) => void,
  onDone: () => void,
  onError: (msg: string) => void
): () => void {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId, brain }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Agent run failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {
            /* ignore malformed chunk */
          }
        }
      }
      onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') onError(err.message);
    }
  })();
  return () => controller.abort();
}
