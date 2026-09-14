import { useCallback, useEffect, useRef, useState } from 'react';
import { api, runAgentStream } from './api';
import type { AgentDecision, CoverageOutcome, Scenario, TraceEvent, WorldState } from './types';
import { ScenarioPanel } from './components/ScenarioPanel';
import { TracePanel } from './components/TracePanel';
import { DecisionCard } from './components/DecisionCard';
import { SupplyPanel } from './components/SupplyPanel';
import { ApprovalsPanel } from './components/ApprovalsPanel';
import { EvaluationPanel } from './components/EvaluationPanel';

type Tab = 'workspace' | 'evaluation';

function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [state, setState] = useState<WorldState | null>(null);
  const [llm, setLlm] = useState<{ configured: boolean; model: string } | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [decision, setDecision] = useState<AgentDecision | null>(null);
  const [outcome, setOutcome] = useState<CoverageOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [brain, setBrain] = useState('auto');
  const [tab, setTab] = useState<Tab>('workspace');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const refreshState = useCallback(() => {
    api.getState().then(setState).catch(() => {});
  }, []);

  useEffect(() => {
    refreshState();
    api.getScenarios().then(setScenarios).catch(() => {});
    api.getLlmInfo().then(setLlm).catch(() => {});
  }, [refreshState]);

  const runScenario = useCallback(
    (scenarioId: string) => {
      abortRef.current?.();
      setRunning(true);
      setActiveId(scenarioId);
      setTrace([]);
      setDecision(null);
      setOutcome(null);
      setError(null);

      abortRef.current = runAgentStream(
        scenarioId,
        brain,
        (ev) => {
          setTrace((t) => [...t, ev]);
          if (ev.type === 'done') {
            if (ev.decision) setDecision(ev.decision);
            if (ev.outcome) setOutcome(ev.outcome);
          }
        },
        () => {
          setRunning(false);
          refreshState();
        },
        (msg) => {
          setError(msg);
          setRunning(false);
          refreshState();
        }
      );
    },
    [brain, refreshState]
  );

  const handleApproval = useCallback(
    async (poId: string, action: 'approve' | 'reject') => {
      try {
        if (action === 'approve') await api.approve(poId);
        else await api.reject(poId);
        refreshState();
      } catch (e: any) {
        setError(e.message);
      }
    },
    [refreshState]
  );

  const handleReset = useCallback(async () => {
    abortRef.current?.();
    setRunning(false);
    await api.reset();
    setTrace([]);
    setDecision(null);
    setOutcome(null);
    setActiveId(null);
    refreshState();
  }, [refreshState]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          <h1>AI Purchasing Agent</h1>
          <p>
            Investigates · decides · acts · validates
            {llm && (
              <span className={`llm-badge ${llm.configured ? 'on' : 'off'}`}>
                {llm.configured ? `LLM: ${llm.model}` : 'LLM not configured — rule brain active'}
              </span>
            )}
          </p>
        </div>
        <div className="app-tabs">
          <button className={tab === 'workspace' ? 'active' : ''} onClick={() => setTab('workspace')}>
            Workspace
          </button>
          <button className={tab === 'evaluation' ? 'active' : ''} onClick={() => setTab('evaluation')}>
            Evaluation
          </button>
          <button className="btn btn-ghost" onClick={handleReset} disabled={running}>
            Reset demo
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {tab === 'workspace' ? (
        <main className="workspace-grid">
          <div className="col-left">
            <ScenarioPanel
              scenarios={scenarios}
              activeId={activeId}
              running={running}
              brain={brain}
              onBrainChange={setBrain}
              onRun={runScenario}
            />
            <DecisionCard decision={decision} outcome={outcome} />
            <ApprovalsPanel state={state} busy={running} onApprove={(id) => handleApproval(id, 'approve')} onReject={(id) => handleApproval(id, 'reject')} />
          </div>
          <div className="col-mid">
            <TracePanel trace={trace} running={running} />
          </div>
          <div className="col-right">
            <SupplyPanel state={state} />
          </div>
        </main>
      ) : (
        <main className="eval-grid">
          <EvaluationPanel />
        </main>
      )}

      <footer className="app-footer">
        Mock ERP resets on every scenario run · all agent actions pass through an independent validation gate · orders
        above $5,000 require human approval
      </footer>
    </div>
  );
}

export default App;
