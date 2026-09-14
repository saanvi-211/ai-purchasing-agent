import type { AgentDecision, CoverageOutcome } from '../types';

const DECISION_META: Record<string, { label: string; cls: string }> = {
  accept: { label: 'ACCEPT', cls: 'dec-accept' },
  modify: { label: 'MODIFY', cls: 'dec-modify' },
  reject: { label: 'REJECT', cls: 'dec-reject' },
  investigate: { label: 'INVESTIGATE', cls: 'dec-investigate' },
  escalate: { label: 'ESCALATE', cls: 'dec-escalate' },
};

export function DecisionCard({ decision, outcome }: { decision: AgentDecision | null; outcome: CoverageOutcome | null }) {
  if (!decision) return null;
  const meta = DECISION_META[decision.decision] || { label: decision.decision.toUpperCase(), cls: '' };

  return (
    <section className={`decision-card ${meta.cls}`}>
      <div className="decision-head">
        <span className="decision-badge">{meta.label}</span>
        <span className="decision-confidence">confidence {(decision.confidence * 100).toFixed(0)}%</span>
      </div>
      <h2 className="decision-headline">{decision.headline}</h2>

      {decision.factors?.length > 0 && (
        <div className="decision-factors">
          <h3>Key factors</h3>
          <ul>
            {decision.factors.map((f, i) => (
              <li key={i} className={`factor factor-${f.impact}`}>
                <span className="factor-name">{f.factor}</span>
                <span className="factor-detail">{f.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="decision-grid">
        {decision.actions_taken?.length > 0 && (
          <div>
            <h3>Actions taken</h3>
            <ul className="decision-actions">
              {decision.actions_taken.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        )}
        {decision.proposed_plan && (
          <div>
            <h3>Proposed plan</h3>
            <p>{decision.proposed_plan}</p>
          </div>
        )}
        {decision.validation && (
          <div>
            <h3>Validation</h3>
            <p>{decision.validation}</p>
          </div>
        )}
      </div>

      {outcome && (
        <div className={`outcome-strip risk-${outcome.stockout_risk}`}>
          <span>Post-run coverage check:</span>
          {outcome.stockout_day !== null ? (
            <strong>stockout still projected on day {outcome.stockout_day}</strong>
          ) : outcome.below_safety_day !== null ? (
            <strong>
              no stockout — dips below safety day {outcome.below_safety_day}, ends at {outcome.end_stock} units
            </strong>
          ) : (
            <strong>
              healthy — ends at {outcome.end_stock} units, above safety stock
            </strong>
          )}
        </div>
      )}
    </section>
  );
}
