import { useState } from 'react';
import type { EvaluationReport } from '../types';
import { api } from '../api';

export function EvaluationPanel() {
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.runEvaluation();
      setReport(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="panel eval-panel">
      <div className="panel-head">
        <h2>Evaluation suite</h2>
        <button className="btn btn-primary" onClick={run} disabled={running}>
          {running ? 'Running…' : 'Run evaluation'}
        </button>
      </div>
      <p className="panel-note">
        Nine test scenarios (the four assignment scenarios plus edge cases: correct recommendation, no need to buy,
        inventory already sufficient, validator-rejection recovery, and one-day demand anomaly) run against the
        deterministic rule brain. Each case is scored on decision correctness, information gathering, constraint
        respect, appropriate action and result validation.
      </p>
      {error && <p className="error-text">{error}</p>}
      {report && (
        <>
          <div className={`eval-summary ${report.totals.failed === 0 ? 'all-pass' : 'has-fail'}`}>
            {report.totals.passed}/{report.totals.total} test scenarios passed
          </div>
          <div className="eval-list">
            {report.results.map((r) => (
              <div key={r.id} className={`eval-case ${r.passed ? 'pass' : 'fail'}`}>
                <div className="eval-case-head">
                  <span className={`eval-badge ${r.passed ? 'pass' : 'fail'}`}>{r.passed ? 'PASS' : 'FAIL'}</span>
                  <span className="eval-name">{r.name}</span>
                </div>
                <div className="eval-checks">
                  {r.checks.map((c, i) => (
                    <div key={i} className={`eval-check ${c.pass ? 'ok' : 'bad'}`}>
                      <span className="eval-check-name">{c.check}</span>
                      <span className="eval-check-detail">{c.detail}</span>
                    </div>
                  ))}
                </div>
                <div className="eval-decision">
                  agent decided <strong>{r.decision.decision}</strong> — {r.decision.headline}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
