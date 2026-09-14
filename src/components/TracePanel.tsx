import type { TraceEvent } from '../types';

function truncate(v: any): string {
  let s: string;
  try {
    s = JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    s = String(v);
  }
  if (s.length > 1200) s = s.slice(0, 1200) + '\n… (truncated)';
  return s;
}

// Merge tool_call followed by its tool_result into a single display item.
interface DisplayItem {
  kind: string;
  ev: TraceEvent;
  result?: TraceEvent;
}

function toDisplayItems(trace: TraceEvent[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (let i = 0; i < trace.length; i++) {
    const ev = trace[i];
    if (ev.type === 'tool_call') {
      const next = trace[i + 1];
      const result = next && next.type === 'tool_result' ? next : undefined;
      if (result) i++;
      items.push({ kind: 'tool', ev, result });
    } else {
      items.push({ kind: ev.type, ev });
    }
  }
  return items;
}

function ToolItem({ item }: { item: DisplayItem }) {
  const { ev, result } = item;
  return (
    <div className="trace-item trace-tool">
      <div className="trace-title">tool · {ev.name}</div>
      {ev.args && Object.keys(ev.args).length > 0 && <pre className="trace-payload">{truncate(ev.args)}</pre>}
      {result && <pre className="trace-payload">{truncate(result.result)}</pre>}
    </div>
  );
}

export function TracePanel({ trace, running }: { trace: TraceEvent[]; running: boolean }) {
  const items = toDisplayItems(trace);

  return (
    <section className="panel trace-panel">
      <div className="panel-head">
        <h2>Agent trace</h2>
        {running && <span className="running-dot" title="agent running" />}
      </div>
      <div className="trace-list">
        {items.length === 0 && !running && (
          <p className="empty-hint">Pick a scenario and run the agent — its full investigation, decisions and validation trail will appear here.</p>
        )}
        {items.map((item, i) => {
          const ev = item.ev;
          switch (item.kind) {
            case 'tool':
              return <ToolItem key={i} item={item} />;
            case 'scenario':
              return (
                <div key={i} className="trace-item trace-scenario">
                  <div className="trace-title">{ev.name}</div>
                  <p>{ev.task}</p>
                  {ev.recommendation && (
                    <p className="trace-rec">
                      Incoming recommendation: <strong>{ev.recommendation.quantity} units</strong> of {ev.recommendation.sku}
                    </p>
                  )}
                </div>
              );
            case 'brain':
              return (
                <div key={i} className="trace-item trace-brain">
                  Brain: <strong>{ev.mode}</strong>
                  {ev.note ? ` — ${ev.note}` : ''}
                </div>
              );
            case 'thought':
              return (
                <div key={i} className="trace-item trace-thought">
                  {ev.text}
                  {ev.data !== undefined && ev.data !== null && <pre className="trace-payload">{truncate(ev.data)}</pre>}
                </div>
              );
            case 'validation_failed':
              return (
                <div key={i} className="trace-item trace-violation">
                  <div className="trace-title">validator rejected {ev.action}</div>
                  {(ev.violations || []).map((v: any, j: number) => (
                    <p key={j}>
                      <span className="violation-rule">{v.rule}</span> {v.message}
                    </p>
                  ))}
                </div>
              );
            case 'action_executed':
              return (
                <div key={i} className="trace-item trace-action">
                  executed {ev.action}: <strong>{ev.po_id}</strong> ({ev.quantity} units, {ev.status})
                </div>
              );
            case 'verification':
              return (
                <div key={i} className={`trace-item ${ev.verified ? 'trace-verified' : 'trace-verified-fail'}`}>
                  <div className="trace-title">
                    {ev.verified ? 'verified' : 'verification failed'} · {ev.po_id}
                  </div>
                  {(ev.checks || []).map((c: any, j: number) => (
                    <p key={j}>
                      [{c.pass ? 'ok' : 'FAIL'}] {c.check}: {c.detail}
                    </p>
                  ))}
                </div>
              );
            case 'escalation':
              return (
                <div key={i} className="trace-item trace-escalation">
                  <div className="trace-title">escalated to human · {ev.title}</div>
                  <p>{ev.summary}</p>
                  {ev.proposed_plan && <p className="trace-plan">Proposed plan: {ev.proposed_plan}</p>}
                </div>
              );
            case 'outcome':
              return (
                <div key={i} className="trace-item trace-outcome">
                  Post-run coverage: end stock {ev.projection?.end_stock}, unmet gap {ev.projection?.unmet_gap}, risk {ev.projection?.stockout_risk}
                </div>
              );
            case 'error':
              return (
                <div key={i} className="trace-item trace-error">
                  error: {ev.message}
                </div>
              );
            default:
              return null;
          }
        })}
      </div>
      {running && <div className="trace-loading">agent working…</div>}
    </section>
  );
}
