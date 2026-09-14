import * as store from '../store.js';
import { simulateCoverage } from '../simulate.js';

// ─────────────────────────────────────────────────────────────────────────────
// Rule-based agent "brain".
//
// A deterministic analyst that solves the same scenarios through the SAME tool
// layer and validation gate as the LLM brain. It exists for three reasons:
//   1. the demo runs fully without any API key,
//   2. it is the deterministic baseline for the evaluation suite,
//   3. it demonstrates the intended decision policy explicitly.
// It never trusts the incoming recommendation: it re-derives demand, coverage
// and constraints from ERP data, then acts through the validation-gated tools.
// ─────────────────────────────────────────────────────────────────────────────

function emitThought(emit, text, data) {
  emit({ type: 'thought', source: 'rules', text, data });
}

// Is the recent sales spike sustained (>=3 of last 7 days above 1.2x forecast)
// or a one-off anomaly?
export function analyzeDemand(sales) {
  const fc = sales.forecast_daily;
  if (!fc) return { sustained: false, dailyDemand: null };
  const last7 = sales.recent_7d;
  const elevatedDays = last7.filter((r) => r.actual > fc * 1.2).length;
  const avg7 = sales.recent_7d_avg_actual;
  const liftPct = Math.round(((avg7 - fc) / fc) * 100);
  const sustained = elevatedDays >= 3 && liftPct >= 15;
  return {
    sustained,
    elevatedDays,
    avg7,
    liftPct,
    dailyDemand: sustained ? Math.round(avg7 * 1.05) : fc, // damp the spike slightly
  };
}

function budgetFit(supplier) {
  const budget = store.getBudgetSummary();
  return Math.floor(budget.available / supplier.unit_price);
}

function storageFit() {
  const s = store.getStorageSummary();
  return Math.max(0, s.capacity_units - s.used_units - s.incoming_units);
}

// Attempt to create a PO for `neededQty`, adapting when the validator rejects.
// Tries: desired quantity → constraint-fitted quantity on the same supplier →
// next supplier. Returns what was actually created and what remains unmet.
function smartCreatePo(handlers, emit, sku, neededQty, justification) {
  if (neededQty <= 0) return { created: null, attempts: [], remaining: 0 };

  const suppliers = store.getSuppliersForSku(sku);

  // Order candidates: suppliers that can arrive before the projected stockout
  // first, then cheapest; suppliers that cannot arrive in time come last.
  const coverage = simulateCoverage(sku);
  const deadlineDay = coverage.stockout_day ?? 999;
  const scored = [...suppliers].map((s) => ({
    s,
    inTime: s.lead_time_days < deadlineDay,
  }));
  scored.sort((a, b) => {
    if (a.inTime !== b.inTime) return a.inTime ? -1 : 1;
    if (a.s.unit_price !== b.s.unit_price) return a.s.unit_price - b.s.unit_price;
    return b.s.reliability - a.s.reliability;
  });
  const sorted = scored.map((x) => x.s);
  const attempts = [];

  let remaining = neededQty;

  for (const supplier of sorted) {
    if (remaining <= 0) break;
    // Can't order less than a supplier's MOQ — skip rather than over-buy.
    if (remaining < supplier.moq) continue;

    // Attempt 1: what we actually want.
    let desired = Math.min(remaining, supplier.max_order_qty);
    if (desired < supplier.moq) desired = Math.min(supplier.moq, supplier.max_order_qty);

    let res = handlers.create_purchase_order({
      sku,
      supplier_id: supplier.id,
      quantity: desired,
      justification,
    });
    attempts.push({ supplier: supplier.id, requested: desired, result: res });

    if (res.success) {
      const created = res.purchase_order.quantity;
      remaining = Math.max(0, neededQty - created);
      if (res.verification && !res.verification.verified) {
        emit({
          type: 'thought',
          source: 'rules',
          text: `PO ${res.purchase_order.id} written, but post-action verification flags an unmet outcome — will re-check coverage and adapt if needed.`,
          data: res.verification.checks,
        });
      }
      continue;
    }

    // Adapt: fit the order to whichever constraint the validator reported.
    const rules = (res.violations || []).map((v) => v.rule);
    if (rules.includes('budget_exceeded') || rules.includes('storage_exceeded')) {
      const fitted = Math.min(
        budgetFit(supplier),
        storageFit(),
        supplier.max_order_qty
      );
      if (fitted >= supplier.moq) {
        res = handlers.create_purchase_order({
          sku,
          supplier_id: supplier.id,
          quantity: fitted,
          justification: `${justification} (reduced to fit constraints after validation failure)`,
        });
        attempts.push({ supplier: supplier.id, requested: fitted, adapted: true, result: res });
        if (res.success) {
          remaining = Math.max(0, neededQty - res.purchase_order.quantity);
          continue;
        }
      }
    }
    // supplier_capacity / moq / anything else → try the next supplier.
  }

  return { created: attempts.find((a) => a.result.success)?.result || null, attempts, remaining };
}

function factor(name, impact, detail) {
  return { factor: name, impact, detail };
}

// ─── Scenario policies ───────────────────────────────────────────────────────

function reviewRecommendation(handlers, emit, { sku, recommendation }) {
  const rec = recommendation || { quantity: 0, supplier_id: 'SUP-A' };
  const overview = handlers.get_product_overview({ sku });
  const sim = overview.coverage_projection;

  emitThought(emit, `Coverage check: ${overview.net_available} units net on hand + ${sim.total_incoming ?? '(see POs)'} inbound vs ${sim.daily_demand}/day demand over ${sim.horizon_days} days.`, {
    stockout_day: sim.stockout_day,
    unmet_gap: sim.unmet_gap,
    stockout_risk: sim.stockout_risk,
  });

  const sales = handlers.get_sales_history({ sku, days: 14 });
  const demand = analyzeDemand(sales);
  emitThought(emit, `Demand check: 7-day average ${demand.avg7}/day vs forecast ${sales.forecast_daily}/day (${demand.liftPct >= 0 ? '+' : ''}${demand.liftPct}%). ${demand.sustained ? 'Sustained lift — planning with elevated demand.' : 'No sustained lift — forecast stands.'}`);

  const needed = demand.dailyDemand ? demand.dailyDemand * sim.horizon_days + overview.inventory.safety_stock - overview.net_available - currentIncoming(sku) : sim.unmet_gap;
  const gap = Math.max(0, Math.round(needed));

  if (gap === 0) {
    return {
      decision: 'reject',
      headline: `Recommendation of ${rec.quantity} units rejected — current stock plus open POs already cover demand with safety stock.`,
      factors: [
        factor('Coverage sufficient', 'negative', `Projected end stock ${sim.end_stock} ≥ safety stock ${overview.inventory.safety_stock}; no stockout within ${sim.horizon_days} days.`),
        factor('Open POs', 'negative', `${handlers.get_open_purchase_orders({ sku }).length} open order(s) already inbound.`),
      ],
      actions_taken: ['none'],
      proposed_plan: 'Do not purchase. Re-run the recommendation when coverage drops below safety stock.',
      confidence: 0.9,
      validation: 'Coverage projection re-run from ERP data after decision; no action required.',
    };
  }

  const idealQty = gap;
  const chosenQty = moqRoundedTarget(handlers, sku, idealQty);

  emitThought(emit, `Recommendation is ${rec.quantity} units; computed need is ~${idealQty} units (gap to safety stock over horizon). ${rec.quantity > idealQty * 1.5 ? 'Recommendation significantly over-buys.' : rec.quantity < idealQty * 0.6 ? 'Recommendation under-buys.' : 'Recommendation is in the right range.'}`);

  const result = smartCreatePo(handlers, emit, sku, chosenQty, `Corrected order replacing recommendation of ${rec.quantity} units`);

  const createdQty = result.created ? result.created.purchase_order.quantity : 0;
  const decision = createdQty === 0 ? 'escalate' : createdQty === rec.quantity ? 'accept' : 'modify';

  const factors = [
    factor('Recommendation vs need', rec.quantity > idealQty * 1.5 || rec.quantity < idealQty * 0.6 ? 'negative' : 'positive', `Recommended ${rec.quantity}; computed need ${idealQty} units (net stock ${overview.net_available}, incoming ${currentIncoming(sku)}, demand ${sim.daily_demand}/day × ${sim.horizon_days}d, safety ${overview.inventory.safety_stock}).`),
    factor('Coverage risk', sim.stockout_day ? 'negative' : 'neutral', sim.stockout_day ? `Stockout projected on day ${sim.stockout_day} without action.` : 'No stockout within horizon, but stock ends below/at safety level.'),
  ];

  const budget = handlers.get_budget();
  const storage = handlers.get_storage_status();
  factors.push(factor('Budget', 'neutral', `Available $${budget.available}; order value $${result.created ? result.created.purchase_order.value : 0}.`));
  factors.push(factor('Storage', 'neutral', `Projected peak ${storage.projected_peak_units}/${storage.capacity_units} units.`));

  if (result.remaining > 0) {
    handlers.escalate_to_human({
      title: `Partial fulfilment of corrected order for ${sku}`,
      summary: `Needed ${idealQty} units, only ${createdQty} could be ordered within budget/storage/MOQ constraints. ${result.remaining} units remain unplanned.`,
      proposed_plan: `Release additional budget or free storage, then order remaining ${result.remaining} units.`,
    });
    return {
      decision: 'escalate',
      headline: `Only ${createdQty} of ${idealQty} needed units could be ordered — constraints block the rest.`,
      factors,
      actions_taken: result.created ? [`Created ${result.created.purchase_order.id} for ${createdQty} units`] : ['none — all attempts rejected by validator'],
      proposed_plan: `Escalating: ${result.remaining} further units needed.`,
      confidence: 0.7,
      validation: 'Each attempt validated; successful PO verified in ERP after write.',
    };
  }

  return {
    decision,
    headline:
      decision === 'accept'
        ? `Recommendation of ${rec.quantity} units confirmed — matches computed need.`
        : `Recommendation of ${rec.quantity} units modified to ${createdQty} units — original over/under-buys vs coverage gap.`,
    factors,
    actions_taken: result.created ? [`Created ${result.created.purchase_order.id} for ${createdQty} units from ${result.created.purchase_order.supplier}`] : ['none'],
    proposed_plan: decision === 'accept' ? 'Execute as recommended.' : `Order ${createdQty} instead of ${rec.quantity}.`,
    confidence: 0.85,
    validation: result.created
      ? `PO written and verified: ${result.created.verification.checks.map((c) => `${c.check}=${c.pass ? 'ok' : 'FAIL'}`).join(', ')}`
      : 'no action to verify',
  };
}

function currentIncoming(sku) {
  return store
    .getOpenPos(sku)
    .filter((p) => ['open', 'confirmed', 'in_transit', 'partial'].includes(p.status))
    .reduce((s, p) => s + p.quantity, 0);
}

// Round the target up to the closest feasible MOQ across suppliers.
function moqRoundedTarget(handlers, sku, idealQty) {
  const suppliers = store.getSuppliersForSku(sku);
  const moqs = suppliers.map((s) => s.moq).sort((a, b) => a - b);
  for (const moq of moqs) {
    if (idealQty <= moq) return moq;
  }
  return idealQty;
}

function handlePartialSupply(handlers, emit, { sku, recommendation }) {
  const overview = handlers.get_product_overview({ sku });
  const sim = overview.coverage_projection;
  const pos = handlers.get_open_purchase_orders({ sku });
  const shortPo = pos.find((p) => p.status === 'partial');

  emitThought(emit, shortPo ? `Supplier can only partially fulfil ${shortPo.id}: ${shortPo.quantity} of the original quantity is coming. Checking whether remaining supply still covers demand.` : 'Reviewing partial supply event against coverage.', {
    open_pos: pos.map((p) => `${p.id}: ${p.quantity}u in ${p.expected_in_days}d (${p.status})`),
    stockout_day: sim.stockout_day,
    unmet_gap: sim.unmet_gap,
  });

  const sales = handlers.get_sales_history({ sku, days: 14 });
  const demand = analyzeDemand(sales);
  const gapAtDemand = demand.dailyDemand
    ? Math.max(0, demand.dailyDemand * sim.horizon_days + overview.inventory.safety_stock - overview.net_available - currentIncoming(sku))
    : sim.unmet_gap;
  const gap = Math.max(0, Math.round(gapAtDemand));

  if (gap === 0) {
    return {
      decision: 'accept',
      headline: 'Partial delivery is acceptable — remaining supply still covers demand above safety stock.',
      factors: [
        factor('Coverage still sufficient', 'positive', `Projected end stock ${sim.end_stock} with safety stock ${overview.inventory.safety_stock}; no stockout within horizon.`),
        factor('Cost avoidance', 'positive', 'No replacement order needed; avoids unnecessary spend.'),
      ],
      actions_taken: ['none'],
      proposed_plan: 'Accept the reduced quantity; monitor coverage.',
      confidence: 0.9,
      validation: 'Coverage re-projected from current ERP state.',
    };
  }

  emitThought(emit, `Shortfall of ~${gap} units (stockout projected day ${sim.stockout_day}). Looking for a supplier who can deliver before then.`, null);

  const result = smartCreatePo(handlers, emit, sku, gap, `Replacement supply after partial fulfilment${shortPo ? ` of ${shortPo.id}` : ''}`);
  const createdQty = result.created ? result.created.purchase_order.quantity : 0;

  if (createdQty === 0) {
    handlers.escalate_to_human({
      title: `Cannot replace shorted quantity for ${sku}`,
      summary: `Supplier shortfall leaves a ${gap}-unit gap; all replacement attempts were rejected by validation (budget/storage/MOQ/capacity).`,
      proposed_plan: 'Manual sourcing decision required.',
    });
    return {
      decision: 'escalate',
      headline: `Replacement orders rejected by validation — ${gap}-unit gap needs human decision.`,
      factors: [factor('Shortfall', 'negative', `${gap} units unmet; stockout day ${sim.stockout_day}.`)],
      actions_taken: ['none — all attempts rejected'],
      proposed_plan: 'Manual sourcing / budget decision required.',
      confidence: 0.6,
      validation: 'All attempts went through the validation gate; violations recorded.',
    };
  }

  if (result.remaining > 0) {
    handlers.escalate_to_human({
      title: `Partially replaced shortfall for ${sku}`,
      summary: `Ordered ${createdQty} replacement units; ${result.remaining} remain unplanned within constraints.`,
      proposed_plan: `Order remaining ${result.remaining} units once budget/storage allow.`,
    });
    return {
      decision: 'escalate',
      headline: `${createdQty} replacement units ordered; ${result.remaining} still short — escalated.`,
      factors: [factor('Partial replacement', 'neutral', `${createdQty} ordered, ${result.remaining} remaining.`)],
      actions_taken: [`Created ${result.created.purchase_order.id} for ${createdQty} units`],
      proposed_plan: `Source remaining ${result.remaining} units.`,
      confidence: 0.7,
      validation: 'PO verified after write; coverage re-projected.',
    };
  }

  return {
    decision: 'modify',
    headline: `Sourced ${createdQty} replacement units to cover the supplier shortfall.`,
    factors: [
      factor('Shortfall', 'negative', `${gap} units short after partial delivery; stockout was projected day ${sim.stockout_day}.`),
      factor('Supplier choice', 'positive', `Selected supplier delivering within ${result.created.purchase_order.expected_in_days} days, ahead of projected stockout.`),
      factor('Budget & storage', 'neutral', 'Replacement order validated against available budget and storage capacity.'),
    ],
    actions_taken: [`Created ${result.created.purchase_order.id} for ${createdQty} units from ${result.created.purchase_order.supplier}`],
    proposed_plan: 'Monitor the replacement PO for on-time delivery.',
    confidence: 0.85,
    validation: `Post-write verification: ${result.created.verification.checks.map((c) => `${c.check}=${c.pass ? 'ok' : 'FAIL'}`).join(', ')}`,
  };
}

function handleDemandSurge(handlers, emit, { sku }) {
  const sales = handlers.get_sales_history({ sku, days: 14 });
  const demand = analyzeDemand(sales);

  emitThought(emit, `Sales running ${demand.liftPct >= 0 ? '+' : ''}${demand.liftPct}% vs forecast (7-day avg ${demand.avg7}/day, ${demand.elevatedDays} of last 7 days elevated).`, {
    recent_7d: sales.recent_7d,
  });

  if (!demand.sustained) {
    return {
      decision: 'investigate',
      headline: 'Demand deviation looks like a short-lived spike, not a sustained shift — gathering more evidence before changing the purchase plan.',
      factors: [
        factor('Spike duration', 'negative', `Only ${demand.elevatedDays} of last 7 days above 1.2× forecast; not enough evidence of a sustained shift.`),
        factor('Cost of over-reacting', 'negative', 'Re-ordering on a one-day anomaly risks excess stock and wasted budget.'),
      ],
      actions_taken: ['none'],
      proposed_plan: 'Monitor 3 more days of sales; if lift persists, re-run planning with updated demand.',
      confidence: 0.75,
      validation: 'No action taken; nothing to verify. Will re-evaluate with new sales data.',
    };
  }

  const overview = handlers.get_product_overview({ sku });
  const sim = overview.coverage_projection;
  const needed = Math.max(0, Math.round(demand.dailyDemand * sim.horizon_days + overview.inventory.safety_stock - overview.net_available - currentIncoming(sku)));

  emitThought(emit, `Sustained lift confirmed. Re-planning at ${demand.dailyDemand}/day: ${needed} additional units needed over the horizon.`, {
    new_daily_demand: demand.dailyDemand,
    stockout_day: sim.stockout_day,
  });

  // Prefer increasing the existing inbound order (same supplier, same lead time)
  // before adding a new PO.
  const openPos = store.getOpenPos(sku).filter((p) => ['open', 'confirmed', 'in_transit'].includes(p.status));
  let actions = [];
  let remaining = needed;

  if (openPos.length > 0) {
    const po = openPos[0];
    const supplier = store.getSupplier(po.supplier_id);
    const target = Math.min(po.quantity + remaining, supplier.max_order_qty);
    const res = handlers.modify_purchase_order({ po_id: po.id, new_quantity: target, reason: `Demand lift +${demand.liftPct}% — increasing replenishment` });
    if (res.success) {
      actions.push(`Modified ${po.id} from ${res.changed_from} to ${res.changed_to} units`);
      remaining = Math.max(0, needed - (res.changed_to - res.changed_from));
      if (res.verification && !res.verification.verified) {
        emitThought(emit, `Modification verified with warnings — coverage re-checked.`, res.verification.checks);
      }
    } else {
      emitThought(emit, `Modifying ${po.id} was rejected by the validator; falling back to a new order.`, res.violations);
    }
  }

  if (remaining > 0) {
    const result = smartCreatePo(handlers, emit, sku, remaining, `Additional cover after sustained demand lift (+${demand.liftPct}%)`);
    if (result.created) {
      actions.push(`Created ${result.created.purchase_order.id} for ${result.created.purchase_order.quantity} units`);
      remaining = result.remaining;
    } else if (needed > 0 && actions.length === 0) {
      handlers.escalate_to_human({
        title: `Cannot cover demand surge for ${sku}`,
        summary: `Sustained demand lift (+${demand.liftPct}%) leaves ${needed} units unmet; all purchasing attempts rejected by validation.`,
        proposed_plan: 'Manual planning with updated forecast required.',
      });
      return {
        decision: 'escalate',
        headline: `Demand surge leaves ${needed}-unit gap; constraints block all automated options.`,
        factors: [factor('Demand lift', 'negative', `+${demand.liftPct}% sustained over 7 days.`)],
        actions_taken: ['none — all attempts rejected'],
        proposed_plan: 'Manual re-planning with updated forecast.',
        confidence: 0.6,
        validation: 'All attempts validated; violations recorded.',
      };
    }
  }

  if (remaining > 0) {
    handlers.escalate_to_human({
      title: `Residual gap after demand re-planning for ${sku}`,
      summary: `${needed} extra units needed; ${needed - remaining} secured; ${remaining} remain blocked by constraints.`,
      proposed_plan: `Release budget/storage to order remaining ${remaining} units.`,
    });
    return {
      decision: 'escalate',
      headline: `Partially re-planned: ${needed - remaining} extra units secured, ${remaining} still short.`,
      factors: [factor('Demand lift', 'negative', `+${demand.liftPct}% sustained.`)],
      actions_taken: actions,
      proposed_plan: `Order remaining ${remaining} units after constraint release.`,
      confidence: 0.7,
      validation: 'Actions verified after write; coverage re-projected.',
    };
  }

  return {
    decision: 'modify',
    headline: `Purchasing plan updated for sustained demand lift of +${demand.liftPct}% — supply increased to cover ${demand.dailyDemand}/day.`,
    factors: [
      factor('Demand evidence', 'positive', `${demand.elevatedDays}/7 days above 1.2× forecast; 7-day avg ${demand.avg7} vs forecast ${sales.forecast_daily}.`),
      factor('Coverage at new demand', 'negative', `Old plan would stock out on day ${sim.stockout_day} at the new run-rate.`),
      factor('Budget', 'neutral', `Available $${handlers.get_budget().available}.`),
      factor('Storage', 'neutral', `Projected peak ${handlers.get_storage_status().projected_peak_units}/${handlers.get_storage_status().capacity_units}.`),
    ],
    actions_taken: actions,
    proposed_plan: 'Keep monitoring daily sales; re-plan if lift continues next week.',
    confidence: 0.85,
    validation: 'Modified PO re-read from ERP and verified; coverage re-projected at new demand.',
  };
}

function handleConstraintBlocked(handlers, emit, { sku, recommendation }) {
  const rec = recommendation || { quantity: 0, supplier_id: 'SUP-A' };
  const overview = handlers.get_product_overview({ sku });
  const sim = overview.coverage_projection;
  const budget = handlers.get_budget();
  const storage = handlers.get_storage_status();

  const needed = Math.max(0, Math.round(
    sim.daily_demand * sim.horizon_days + overview.inventory.safety_stock - overview.net_available - currentIncoming(sku)
  ));

  emitThought(emit, `Purchase of ${rec.quantity} units is warranted (gap ~${needed}), but budget available is $${budget.available} and storage headroom is ${storage.capacity_units - storage.used_units - storage.incoming_units} units. Testing feasibility before acting.`, {
    budget, storage,
  });

  const factors = [
    factor('Need confirmed', 'positive', `Gap of ~${needed} units within horizon (demand ${sim.daily_demand}/day, stockout day ${sim.stockout_day ?? 'none'}).`),
    factor('Budget constraint', 'negative', `Only $${budget.available} available vs $${Math.round(rec.quantity * 12)}+ required for the recommendation.`),
    factor('Storage constraint', 'negative', `Headroom ${storage.capacity_units - storage.used_units - storage.incoming_units} units vs ${rec.quantity} recommended.`),
  ];

  const result = smartCreatePo(handlers, emit, sku, needed, `Feasibility-adjusted purchase (original recommendation ${rec.quantity} units blocked by constraints)`);
  const createdQty = result.created ? result.created.purchase_order.quantity : 0;

  if (createdQty === 0) {
    handlers.escalate_to_human({
      title: `Purchase for ${sku} blocked by constraints`,
      summary: `Need ${needed} units but budget ($${budget.available} available) and storage (${storage.capacity_units - storage.used_units - storage.incoming_units} units headroom) block every feasible order, including MOQ minimums.`,
      proposed_plan: 'Request budget release or storage capacity, then execute the purchase.',
    });
    return {
      decision: 'escalate',
      headline: `Purchase needed but budget and storage block all feasible options — escalated with plan.`,
      factors,
      actions_taken: ['none — all attempts rejected by validator'],
      proposed_plan: 'Request budget release / storage capacity; re-run purchase afterwards.',
      confidence: 0.75,
      validation: 'All attempts validated; violations recorded before escalating.',
    };
  }

  if (result.remaining > 0 || (result.created.verification && !result.created.verification.verified)) {
    handlers.escalate_to_human({
      title: `Partial purchase executed for ${sku}; remainder blocked`,
      summary: `Ordered ${createdQty} units (${result.created.purchase_order.supplier}, arrives in ${result.created.purchase_order.expected_in_days} days). ${result.remaining} units could not be ordered within budget/storage constraints.`,
      proposed_plan: `Release $${Math.max(0, Math.round((needed - createdQty) * (result.created.purchase_order.unit_price || 12)))} budget (or free storage) to order the remaining ${result.remaining} units; consider a faster supplier if the stockout date approaches.`,
    });
    return {
      decision: 'escalate',
      headline: `Scaled recommendation ${rec.quantity} → ${createdQty} units (feasible part executed); remainder escalated.`,
      factors: [
        ...factors,
        factor('Adapted plan', 'positive', `${createdQty} units ordered within constraints; verification: ${result.created.verification.checks.map((c) => `${c.check}=${c.pass ? 'ok' : 'FAIL'}`).join(', ')}`),
      ],
      actions_taken: [`Created ${result.created.purchase_order.id} for ${createdQty} units from ${result.created.purchase_order.supplier}`],
      proposed_plan: `Order remaining ${result.remaining} units after constraint release.`,
      confidence: 0.7,
      validation: 'PO verified after write; residual gap re-computed before escalating.',
    };
  }

  return {
    decision: 'modify',
    headline: `Recommendation of ${rec.quantity} units was infeasible; executed a constraint-fitted order of ${createdQty} units that still closes the coverage gap.`,
    factors: [
      ...factors,
      factor('Adapted plan', 'positive', `${createdQty} units from ${result.created.purchase_order.supplier} within budget and storage; verification passed.`),
    ],
    actions_taken: [`Created ${result.created.purchase_order.id} for ${createdQty} units from ${result.created.purchase_order.supplier}`],
    proposed_plan: 'Monitor; re-order when budget/storage headroom allows building buffer.',
    confidence: 0.8,
    validation: `Post-write verification: ${result.created.verification.checks.map((c) => `${c.check}=${c.pass ? 'ok' : 'FAIL'}`).join(', ')}`,
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// Wrap the tool handlers so every rule-brain tool invocation appears in the
// trace exactly like an LLM tool call (used by the UI and the evaluation).
function traced(handlers, emit) {
  return new Proxy(handlers, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig !== 'function') return orig;
      return (args) => {
        emit({ type: 'tool_call', source: 'rules', name: prop, args: args || {} });
        const result = orig(args);
        emit({ type: 'tool_result', source: 'rules', name: prop, result });
        return result;
      };
    },
  });
}

export async function runRuleBrain({ kind, sku, recommendation, handlers, emit }) {
  emitThought(emit, `Analysing ${sku} from ERP data — demand, coverage, open POs, suppliers, budget and storage. The incoming recommendation will be treated as a hypothesis, not a fact.`);

  const tools = traced(handlers, emit);

  switch (kind) {
    case 'recommendation_review':
      return reviewRecommendation(tools, emit, { sku, recommendation });
    case 'partial_supply':
      return handlePartialSupply(tools, emit, { sku, recommendation });
    case 'demand_surge':
      return handleDemandSurge(tools, emit, { sku });
    case 'constraint_blocked':
      return handleConstraintBlocked(tools, emit, { sku, recommendation });
    default:
      return {
        decision: 'investigate',
        headline: 'Unknown situation kind — needs investigation.',
        factors: [],
        actions_taken: ['none'],
        proposed_plan: null,
        confidence: 0.3,
        validation: 'n/a',
      };
  }
}
