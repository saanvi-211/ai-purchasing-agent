import type { Scenario } from '../types';

const KIND_LABEL: Record<string, string> = {
  recommendation_review: 'Recommendation review',
  partial_supply: 'Supplier shortfall',
  demand_surge: 'Demand shift',
  constraint_blocked: 'Constraint blocked',
};

export function ScenarioPanel({
  scenarios,
  activeId,
  running,
  brain,
  onBrainChange,
  onRun,
}: {
  scenarios: Scenario[];
  activeId: string | null;
  running: boolean;
  brain: string;
  onBrainChange: (b: string) => void;
  onRun: (id: string) => void;
}) {
  return (
    <section className="panel scenario-panel">
      <div className="panel-head">
        <h2>Scenarios</h2>
        <div className="brain-select">
          <label htmlFor="brain">Brain</label>
          <select id="brain" value={brain} onChange={(e) => onBrainChange(e.target.value)} disabled={running}>
            <option value="auto">auto</option>
            <option value="rules">rules (deterministic)</option>
            <option value="llm">llm</option>
          </select>
        </div>
      </div>
      <div className="scenario-list">
        {scenarios.map((s) => (
          <button
            key={s.id}
            className={`scenario-card ${activeId === s.id ? 'active' : ''}`}
            disabled={running}
            onClick={() => onRun(s.id)}
          >
            <span className="scenario-kind">{KIND_LABEL[s.kind] || s.kind}</span>
            <span className="scenario-name">{s.name}</span>
            {s.recommendation && (
              <span className="scenario-rec">recommendation: {s.recommendation.quantity} units</span>
            )}
            <span className="scenario-run">{running && activeId === s.id ? 'running…' : 'Run agent →'}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
