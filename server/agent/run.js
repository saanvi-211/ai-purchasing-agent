import { resetWorld } from '../store.js';
import { createToolContext, toolSchemas } from '../tools.js';
import { getScenario } from '../scenarios.js';
import { simulateCoverage } from '../simulate.js';
import { runRuleBrain } from './ruleBrain.js';
import { runLlmBrain, llmConfigured } from './llmBrain.js';

// Agent orchestrator: resets the world for the scenario, wires the tools and
// brains, runs the loop, and streams trace events to the caller (SSE in the
// UI, collector in the evaluation harness).

function resolveBrainMode(requested) {
  if (requested === 'rules') return 'rules';
  if (requested === 'llm') return llmConfigured() ? 'llm' : 'rules';
  // auto
  return llmConfigured() ? 'llm' : 'rules';
}

export async function runAgentScenario({ scenarioId, brain = 'auto', emit = () => {} }) {
  const scenario = getScenario(scenarioId);
  if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);

  resetWorld(scenario.overlay);
  emit({
    type: 'scenario',
    scenarioId: scenario.id,
    name: scenario.name,
    kind: scenario.kind,
    sku: scenario.sku,
    recommendation: scenario.recommendation,
    task: scenario.task,
  });

  const handlers = createToolContext({ emit });
  const mode = resolveBrainMode(brain);
  emit({ type: 'brain', mode, note: mode === 'rules' && brain !== 'rules' ? 'No OPENAI_API_KEY configured — using deterministic rule brain.' : null });

  let decision;
  const startedAt = Date.now();
  try {
    if (mode === 'llm') {
      decision = await runLlmBrain({
        sku: scenario.sku,
        recommendation: scenario.recommendation,
        task: scenario.task,
        handlers,
        schemas: toolSchemas(),
        emit,
      });
    } else {
      decision = await runRuleBrain({
        kind: scenario.kind,
        sku: scenario.sku,
        recommendation: scenario.recommendation,
        handlers,
        emit,
      });
    }
  } catch (err) {
    decision = {
      decision: 'escalate',
      headline: `Agent failed to complete: ${err.message}`,
      factors: [{ factor: 'Agent error', impact: 'negative', detail: err.message }],
      actions_taken: ['unknown — see trace'],
      proposed_plan: 'Manual review required.',
      confidence: 0,
      validation: 'Agent aborted before completing validation.',
    };
    emit({ type: 'error', message: err.message });
  }

  // Final outcome check: re-project coverage after whatever the agent did.
  const outcome = simulateCoverage(scenario.sku);
  emit({ type: 'outcome', projection: {
    stockout_day: outcome.stockout_day,
    below_safety_day: outcome.below_safety_day,
    end_stock: outcome.end_stock,
    unmet_gap: outcome.unmet_gap,
    stockout_risk: outcome.stockout_risk,
  } });

  const result = { decision, mode, durationMs: Date.now() - startedAt, outcome };
  emit({ type: 'done', ...result });
  return result;
}
