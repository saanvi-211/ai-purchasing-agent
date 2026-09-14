import * as store from './store.js';
import { simulateCoverage } from './simulate.js';

// ─────────────────────────────────────────────────────────────────────────────
// Independent validation gate.
//
// The agent NEVER writes to the ERP directly. Every mutating action goes
// through this module, which re-derives the facts from the world state and
// rejects actions that would violate budget, storage, MOQ, capacity or
// duplication constraints. If an action is rejected, the violation report is
// fed back to the agent so it can adapt (retry with a different plan, or
// escalate). This is the core feedback loop of the system.
// ─────────────────────────────────────────────────────────────────────────────

export function validateCreatePo({ sku, supplier_id, quantity }) {
  const violations = [];
  const warnings = [];

  const product = store.getProduct(sku);
  if (!product) return { ok: false, violations: [{ rule: 'unknown_product', message: `Unknown SKU ${sku}` }], warnings };

  const supplier = store.getSupplier(supplier_id);
  if (!supplier || !supplier.skus.includes(sku)) {
    return {
      ok: false,
      violations: [{ rule: 'invalid_supplier', message: `Supplier ${supplier_id} does not supply ${sku}` }],
      warnings,
    };
  }

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, violations: [{ rule: 'invalid_quantity', message: `Quantity must be positive, got ${quantity}` }], warnings };
  }

  if (qty < supplier.moq) {
    violations.push({
      rule: 'supplier_moq',
      message: `Quantity ${qty} is below ${supplier.name} MOQ of ${supplier.moq}`,
    });
  }
  if (qty > supplier.max_order_qty) {
    violations.push({
      rule: 'supplier_capacity',
      message: `Quantity ${qty} exceeds ${supplier.name} max order size of ${supplier.max_order_qty}`,
    });
  }

  const budget = store.getBudgetSummary();
  const value = Math.round(qty * supplier.unit_price);
  if (value > budget.available) {
    violations.push({
      rule: 'budget_exceeded',
      message: `Order value $${value} exceeds available budget $${budget.available} (total $${budget.total} − spent $${budget.spent} − committed $${budget.committed})`,
    });
  }

  const storage = store.getStorageSummary();
  const projectedPeak = storage.used_units + storage.incoming_units + qty;
  if (projectedPeak > storage.capacity_units) {
    violations.push({
      rule: 'storage_exceeded',
      message: `Projected storage peak ${projectedPeak} units exceeds capacity ${storage.capacity_units} (used ${storage.used_units} + inbound ${storage.incoming_units} + new ${qty})`,
    });
  }

  // Duplicate guard: an open PO from the same supplier arriving around the same time.
  const duplicate = store
    .getOpenPos(sku)
    .find((po) => po.supplier_id === supplier_id && Math.abs(po.expected_in_days - supplier.lead_time_days) <= 1);
  if (duplicate) {
    warnings.push({
      rule: 'possible_duplicate',
      message: `Open PO ${duplicate.id} from ${supplier.name} already arrives in ${duplicate.expected_in_days} days — confirm a second order is intended`,
    });
  }

  // Lead-time feasibility: will this arrive before projected stockout?
  const sim = simulateCoverage(sku);
  if (sim.stockout_day !== null && supplier.lead_time_days >= sim.stockout_day) {
    warnings.push({
      rule: 'late_arrival',
      message: `${supplier.name} lead time is ${supplier.lead_time_days} days but projected stockout is day ${sim.stockout_day} — this order will not prevent the stockout`,
    });
  }

  return { ok: violations.length === 0, violations, warnings, value, supplier, qty };
}

export function validateModifyPo({ po_id, new_quantity }) {
  const po = store.getPo(po_id);
  if (!po) return { ok: false, violations: [{ rule: 'unknown_po', message: `PO ${po_id} not found` }], warnings: [] };
  if (!['open', 'confirmed', 'pending_approval'].includes(po.status)) {
    return {
      ok: false,
      violations: [{ rule: 'po_not_modifiable', message: `PO ${po_id} has status ${po.status} and cannot be modified` }],
      warnings: [],
    };
  }

  const violations = [];
  const warnings = [];
  const qty = Number(new_quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, violations: [{ rule: 'invalid_quantity', message: `New quantity must be positive` }], warnings };
  }

  const supplier = store.getSupplier(po.supplier_id);
  if (qty < supplier.moq) {
    violations.push({ rule: 'supplier_moq', message: `New quantity ${qty} is below ${supplier.name} MOQ of ${supplier.moq}` });
  }
  if (qty > supplier.max_order_qty) {
    violations.push({ rule: 'supplier_capacity', message: `New quantity ${qty} exceeds ${supplier.name} max order size of ${supplier.max_order_qty}` });
  }

  const delta = qty - po.quantity;
  if (delta > 0) {
    const budget = store.getBudgetSummary();
    const extra = Math.round(delta * po.unit_price);
    if (extra > budget.available) {
      violations.push({
        rule: 'budget_exceeded',
        message: `Increase of ${delta} units costs $${extra}, exceeding available budget $${budget.available}`,
      });
    }
    const storage = store.getStorageSummary();
    const projectedPeak = storage.used_units + storage.incoming_units + delta;
    if (projectedPeak > storage.capacity_units) {
      violations.push({
        rule: 'storage_exceeded',
        message: `Increase of ${delta} units pushes projected storage peak to ${projectedPeak}, over capacity ${storage.capacity_units}`,
      });
    }
  }

  return { ok: violations.length === 0, violations, warnings, po, supplier, qty, delta };
}

export function validateCancelPo({ po_id }) {
  const po = store.getPo(po_id);
  if (!po) return { ok: false, violations: [{ rule: 'unknown_po', message: `PO ${po_id} not found` }], warnings: [] };
  if (!['open', 'confirmed', 'pending_approval'].includes(po.status)) {
    return {
      ok: false,
      violations: [{ rule: 'po_not_cancellable', message: `PO ${po_id} has status ${po.status} and cannot be cancelled` }],
      warnings: [],
    };
  }
  return { ok: true, violations: [], warnings: [], po };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-action verification: after a mutation is written, re-read it from the
// ERP and re-check the outcome the agent expected. If reality diverges from
// intent, the caller gets a `verified: false` result and must react.
// ─────────────────────────────────────────────────────────────────────────────

export function verifyCreatePo(po, expected = {}) {
  const checks = [];
  const fresh = store.getPo(po.id);

  checks.push({
    check: 'po_exists',
    pass: !!fresh,
    detail: fresh ? `${fresh.id} written to ERP with status ${fresh.status}` : 'PO missing after write',
  });

  if (fresh) {
    checks.push({
      check: 'quantity_matches_intent',
      pass: fresh.quantity === expected.quantity,
      detail: `expected ${expected.quantity}, found ${fresh.quantity}`,
    });
    checks.push({
      check: 'supplier_matches_intent',
      pass: fresh.supplier_id === expected.supplier_id,
      detail: `expected ${expected.supplier_id}, found ${fresh.supplier_id}`,
    });

    // Re-derive constraints from the world as it now stands.
    const budget = store.getBudgetSummary();
    checks.push({
      check: 'budget_ok_after_write',
      pass: budget.available >= 0,
      detail: `available budget after write: $${budget.available}`,
    });
    const storage = store.getStorageSummary();
    checks.push({
      check: 'storage_ok_after_write',
      pass: storage.projected_peak_units <= storage.capacity_units,
      detail: `projected peak ${storage.projected_peak_units} / capacity ${storage.capacity_units}`,
    });

    // Outcome verification: does the new supply actually close the coverage gap?
    const sim = simulateCoverage(fresh.sku);
    checks.push({
      check: 'expected_outcome_achieved',
      pass: sim.stockout_day === null,
      detail:
        sim.stockout_day === null
          ? sim.below_safety_day !== null
            ? `no stockout, but stock dips below safety on day ${sim.below_safety_day} (end ${sim.end_stock})`
            : `no stockout within horizon; end stock ${sim.end_stock}`
          : `stockout still projected on day ${sim.stockout_day} despite new PO`,
    });
  }

  const passed = checks.every((c) => c.pass);
  return { verified: passed, checks };
}

export function verifyModifyPo(poId, expectedQty) {
  const fresh = store.getPo(poId);
  const checks = [
    {
      check: 'po_updated',
      pass: !!fresh && fresh.quantity === expectedQty,
      detail: fresh ? `PO ${fresh.id} now ${fresh.quantity} units` : `PO ${poId} missing`,
    },
  ];
  if (fresh) {
    const sim = simulateCoverage(fresh.sku);
    checks.push({
      check: 'expected_outcome_achieved',
      pass: sim.stockout_day === null,
      detail: sim.stockout_day === null ? `no stockout; end stock ${sim.end_stock}` : `stockout still projected day ${sim.stockout_day}`,
    });
  }
  return { verified: checks.every((c) => c.pass), checks };
}
