import { resetWorld, getWorld } from './store.js';
import { getScenario } from './scenarios.js';
import { createToolContext } from './tools.js';
import { runRuleBrain } from './agent/ruleBrain.js';

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation harness.
//
// Each test case runs the agent (rule brain = deterministic baseline) against a
// fresh world, then checks properties across five dimensions taken from the
// assignment brief:
//   1. decision correctness      (right decision type for the situation)
//   2. information gathering     (did it investigate the relevant data?)
//   3. constraint respect        (no order violates budget/storage/MOQ/capacity)
//   4. appropriate action        (the world ends up in the intended state)
//   5. result validation         (actions were written correctly + recovery)
// ─────────────────────────────────────────────────────────────────────────────

const newPoValue = (world) =>
  world.purchase_orders
    .filter((p) => p.created_in_days_ago === 0 && p.id !== 'PO-1042' && p.id !== 'PO-1043' && p.id !== 'PO-1077')
    .reduce((s, p) => s + p.quantity * p.unit_price, 0);

function noConstraintViolations() {
  return (ctx) => {
    const world = getWorld();
    const budget = { total: world.budget.total, spent: world.budget.spent };
    const committed = world.purchase_orders
      .filter((p) => ['open', 'confirmed', 'in_transit', 'pending_approval', 'partial'].includes(p.status))
      .reduce((s, p) => s + p.quantity * p.unit_price, 0);
    const availableOk = budget.total - budget.spent - committed >= -0.01;
    const used = world.inventory.reduce((s, i) => s + i.on_hand, 0);
    const incoming = world.purchase_orders
      .filter((p) => ['confirmed', 'in_transit', 'partial', 'pending_approval'].includes(p.status))
      .reduce((s, p) => s + p.quantity, 0);
    const capacity = world.storage.capacity_units;
    const storageOk = used + incoming <= capacity;
    const moqOk = world.purchase_orders.every((p) => {
      if (!['confirmed', 'pending_approval'].includes(p.status) || p.created_in_days_ago !== 0) return true;
      const sup = world.suppliers.find((s) => s.id === p.supplier_id);
      return p.quantity >= sup.moq && p.quantity <= sup.max_order_qty;
    });
    return {
      pass: availableOk && storageOk && moqOk,
      detail: `budget_ok=${availableOk}, storage_ok=${storageOk} (used ${used} + inbound ${incoming} / cap ${capacity}), moq_ok=${moqOk}`,
    };
  };
}

function poCreatedForSku(sku, { minQty = 1, maxQty = Infinity } = {}) {
  return (ctx) => {
    const world = getWorld();
    const po = world.purchase_orders.find(
      (p) => p.sku === sku && p.created_in_days_ago === 0 && ['confirmed', 'pending_approval'].includes(p.status)
    );
    return {
      pass: !!po && po.quantity >= minQty && po.quantity <= maxQty,
      detail: po ? `${po.id} ${po.quantity}u from ${po.supplier_id}` : 'no new PO created',
    };
  };
}

function poModified(minQty, maxQty = Infinity) {
  return (ctx) => {
    const world = getWorld();
    const po = world.purchase_orders.find((p) => p.id === 'PO-1042');
    return {
      pass: !!po && po.quantity >= minQty && po.quantity <= maxQty,
      detail: po ? `PO-1042 now ${po.quantity}u (was 400)` : 'PO-1042 missing',
    };
  };
}

function decisionIs(...types) {
  return (ctx) => ({ pass: types.includes(ctx.decision.decision), detail: `decision=${ctx.decision.decision}, expected one of ${types.join('/')}` });
}

function noNewPo() {
  return (ctx) => {
    const world = getWorld();
    const created = world.purchase_orders.filter((p) => p.created_in_days_ago === 0 && !['cancelled'].includes(p.status));
    return { pass: created.length === 0, detail: created.length ? `unexpected POs: ${created.map((p) => p.id).join(', ')}` : 'no new POs' };
  };
}

function toolsUsed(...names) {
  return (ctx) => {
    const used = new Set(ctx.trace.filter((e) => e.type === 'tool_call').map((e) => e.name));
    const missing = names.filter((n) => !used.has(n));
    return { pass: missing.length === 0, detail: missing.length ? `did not call: ${missing.join(', ')}` : `called ${[...used].join(', ')}` };
  };
}

function validationRan() {
  return (ctx) => {
    const events = ctx.trace.filter((e) => ['verification', 'action_executed', 'validation_failed'].includes(e.type));
    return { pass: events.length > 0, detail: `${events.length} validation/verification events` };
  };
}

function recoveryFromRejection() {
  return (ctx) => {
    const rejected = ctx.trace.some((e) => e.type === 'validation_failed');
    const eventuallyCreated = getWorld().purchase_orders.some(
      (p) => p.created_in_days_ago === 0 && ['confirmed', 'pending_approval'].includes(p.status)
    );
    return { pass: rejected && eventuallyCreated, detail: `validator rejected an attempt=${rejected}, replacement PO created=${eventuallyCreated}` };
  };
}

function escalationRaised() {
  return (ctx) => {
    const esc = ctx.trace.some((e) => e.type === 'escalation') || ctx.decision.decision === 'escalate';
    return { pass: esc, detail: `escalation=${esc}` };
  };
}

export const EVALUATION_CASES = [
  {
    id: 'S1-overbuy',
    name: 'S1: 800-unit recommendation vs ~180-unit gap → modified down',
    scenarioId: 'scenario-1',
    checks: [
      ['decision_correct', decisionIs('modify', 'accept')],
      ['information_gathered', toolsUsed('get_product_overview')],
      ['constraints_respected', noConstraintViolations()],
      ['action_appropriate', poCreatedForSku('SKU-COFFEE-1L', { minQty: 100, maxQty: 400 })],
      ['result_validated', validationRan()],
    ],
  },
  {
    id: 'S1-correct-recommendation',
    name: 'S1b: recommendation already right (250 units) → accepted, executed as-is',
    scenarioId: 'scenario-1',
    recommendationOverride: { sku: 'SKU-COFFEE-1L', quantity: 250, supplier_id: 'SUP-A' },
    checks: [
      ['decision_correct', decisionIs('accept')],
      ['constraints_respected', noConstraintViolations()],
      ['action_appropriate', poCreatedForSku('SKU-COFFEE-1L', { minQty: 200, maxQty: 300 })],
      ['result_validated', validationRan()],
    ],
  },
  {
    id: 'S1-no-need',
    name: 'S1c: warehouse already full of stock → recommendation rejected, no order',
    scenarioId: 'scenario-1',
    patch(world) {
      world.inventory.find((i) => i.sku === 'SKU-COFFEE-1L').on_hand = 1100;
    },
    checks: [
      ['decision_correct', decisionIs('reject', 'investigate')],
      ['information_gathered', toolsUsed('get_product_overview')],
      ['constraints_respected', noConstraintViolations()],
      ['action_appropriate', noNewPo()],
    ],
  },
  {
    id: 'S2-source-elsewhere',
    name: 'S2: 250/500 partial supply → replacement order covers the gap',
    scenarioId: 'scenario-2',
    checks: [
      ['decision_correct', decisionIs('modify', 'accept', 'escalate')],
      ['information_gathered', toolsUsed('get_product_overview')],
      ['constraints_respected', noConstraintViolations()],
      ['action_appropriate', poCreatedForSku('SKU-COFFEE-1L', { minQty: 100, maxQty: 600 })],
      ['result_validated', validationRan()],
    ],
  },
  {
    id: 'S2-inventory-sufficient',
    name: 'S2b: inventory already covers the shortfall → accept partial, no replacement',
    scenarioId: 'scenario-2',
    patch(world) {
      world.inventory.find((i) => i.sku === 'SKU-COFFEE-1L').on_hand = 900;
    },
    checks: [
      ['decision_correct', decisionIs('accept', 'investigate')],
      ['constraints_respected', noConstraintViolations()],
      ['action_appropriate', noNewPo()],
    ],
  },
  {
    id: 'S2-retry-after-rejection',
    name: 'S2c: primary supplier at capacity → validator rejects, agent recovers via another supplier',
    scenarioId: 'scenario-2',
    patch(world) {
      world.suppliers.find((s) => s.id === 'SUP-A').max_order_qty = 200; // below MOQ 250
    },
    checks: [
      ['recovery', recoveryFromRejection()],
      ['constraints_respected', noConstraintViolations()],
      ['action_appropriate', poCreatedForSku('SKU-COFFEE-1L', { minQty: 100, maxQty: 600 })],
    ],
  },
  {
    id: 'S3-surge',
    name: 'S3: sustained demand lift → purchase plan increased',
    scenarioId: 'scenario-3',
    checks: [
      ['decision_correct', decisionIs('modify', 'accept')],
      ['information_gathered', toolsUsed('get_sales_history')],
      ['constraints_respected', noConstraintViolations()],
      ['action_appropriate', poModified(800, 1000)],
      ['result_validated', validationRan()],
    ],
  },
  {
    id: 'S3-anomaly',
    name: 'S3b: one-day sales spike → investigate, do NOT re-order',
    scenarioId: 'scenario-3',
    patch(world) {
      const rows = world.sales_history.filter((r) => r.sku === 'SKU-COFFEE-1L');
      rows.forEach((r) => (r.actual = 44 + (Math.abs(r.day_offset) % 3)));
      rows[rows.length - 1].actual = 95; // single-day spike only
    },
    checks: [
      ['decision_correct', decisionIs('investigate')],
      ['action_appropriate', noNewPo()],
      ['constraints_respected', noConstraintViolations()],
    ],
  },
  {
    id: 'S4-constraint',
    name: 'S4: budget+storage block the 400-unit plan → feasible part executed, rest escalated',
    scenarioId: 'scenario-4',
    checks: [
      ['decision_correct', decisionIs('escalate', 'modify')],
      ['information_gathered', toolsUsed('get_budget', 'get_storage_status')],
      ['constraints_respected', noConstraintViolations()],
      ['human_in_loop', escalationRaised()],
    ],
  },
];

export async function runEvaluation() {
  const results = [];
  for (const testCase of EVALUATION_CASES) {
    const scenario = getScenario(testCase.scenarioId);
    const trace = [];
    const emit = (e) => trace.push(e);

    resetWorld(scenario.overlay);
    const originalRecommendation = scenario.recommendation;
    if (testCase.recommendationOverride) scenario.recommendation = testCase.recommendationOverride;
    if (testCase.patch) testCase.patch(getWorld());

    const handlers = createToolContext({ emit });

    let decision;
    try {
      decision = await runRuleBrain({
        kind: scenario.kind,
        sku: scenario.sku,
        recommendation: scenario.recommendation,
        handlers,
        emit,
      });
    } catch (err) {
      decision = { decision: 'escalate', headline: `Agent error: ${err.message}` };
    }

    // Restore the scenario definition so later runs are unaffected.
    scenario.recommendation = originalRecommendation;

    const ctx = { decision, trace, scenario };
    const checkResults = testCase.checks.map(([name, fn]) => {
      try {
        const r = fn(ctx);
        return { check: name, pass: !!r.pass, detail: r.detail };
      } catch (err) {
        return { check: name, pass: false, detail: `check error: ${err.message}` };
      }
    });

    results.push({
      id: testCase.id,
      name: testCase.name,
      passed: checkResults.every((c) => c.pass),
      checks: checkResults,
      decision: {
        decision: decision.decision,
        headline: decision.headline,
        actions_taken: decision.actions_taken,
        validation: decision.validation,
      },
    });
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    ranAt: new Date().toISOString(),
    totals: { passed, failed: results.length - passed, total: results.length },
    results,
  };
}
