import { runEvaluation } from './evaluation.js';

const report = await runEvaluation();

console.log('\n=== AI Purchasing Agent — Evaluation Scorecard ===\n');
for (const r of report.results) {
  console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.id} — ${r.name}`);
  for (const c of r.checks) {
    console.log(`      [${c.pass ? 'ok' : 'XX'}] ${c.check}: ${c.detail}`);
  }
  console.log(`      decision: ${r.decision.decision} — ${r.decision.headline}\n`);
}
console.log(`Total: ${report.totals.passed}/${report.totals.total} passed\n`);
process.exit(report.totals.failed === 0 ? 0 : 1);
