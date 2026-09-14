import * as store from './store.js';
import { simulateCoverage, recommendedQty } from './simulate.js';
import {
  validateCreatePo,
  validateModifyPo,
  validateCancelPo,
  verifyCreatePo,
  verifyModifyPo,
} from './validator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool registry. Read tools let the agent investigate the ERP; action tools
// are the ONLY way to mutate the world and all of them pass through the
// independent validation gate before writing. The schemas double as the
// OpenAI-style function definitions for the LLM brain.
// ─────────────────────────────────────────────────────────────────────────────

function summarizePo(po) {
  const supplier = store.getSupplier(po.supplier_id);
  return {
    id: po.id,
    sku: po.sku,
    supplier: supplier ? supplier.name : po.supplier_id,
    supplier_id: po.supplier_id,
    quantity: po.quantity,
    unit_price: po.unit_price,
    value: Math.round(po.quantity * po.unit_price),
    status: po.status,
    expected_in_days: po.expected_in_days,
    expected_date: po.expected_date,
    note: po.note,
  };
}

export function createToolContext({ emit }) {
  const log = (type, payload) => emit && emit({ type, ...payload });

  const handlers = {
    get_product_overview({ sku }) {
      const product = store.getProduct(sku);
      if (!product) return { error: `Unknown SKU ${sku}` };
      const inv = store.getInventory(sku);
      const fc = store.getForecast(sku);
      const sim = simulateCoverage(sku);
      return {
        product,
        inventory: inv,
        net_available: inv.on_hand - inv.reserved,
        forecast: fc,
        open_purchase_orders: store.getOpenPos(sku).map(summarizePo),
        coverage_projection: {
          horizon_days: sim.horizon_days,
          daily_demand: sim.daily_demand,
          stockout_day: sim.stockout_day,
          below_safety_day: sim.below_safety_day,
          end_stock: sim.end_stock,
          unmet_gap: sim.unmet_gap,
          stockout_risk: sim.stockout_risk,
        },
      };
    },

    get_sales_history({ sku, days }) {
      const rows = store.getSalesHistory(sku, days || 28);
      const last7 = rows.slice(-7);
      const prev21 = rows.slice(0, -7);
      const avg = (rs) => (rs.length ? Math.round(rs.reduce((s, r) => s + r.actual, 0) / rs.length) : 0);
      const fc = store.getForecast(sku);
      return {
        sku,
        recent_7d_avg_actual: avg(last7),
        prior_21d_avg_actual: avg(prev21),
        forecast_daily: fc ? fc.daily_expected : null,
        recent_7d: last7.map((r) => ({ day: r.day_offset, actual: r.actual, forecast: r.forecast })),
        trend_vs_forecast_pct: fc && fc.daily_expected ? Math.round(((avg(last7) - fc.daily_expected) / fc.daily_expected) * 100) : null,
      };
    },

    get_suppliers({ sku }) {
      const suppliers = sku ? store.getSuppliersForSku(sku) : store.getWorld().suppliers;
      const budget = store.getBudgetSummary();
      return { suppliers, budget_available: budget.available };
    },

    get_budget() {
      return store.getBudgetSummary();
    },

    get_storage_status() {
      return store.getStorageSummary();
    },

    get_open_purchase_orders({ sku }) {
      const pos = sku ? store.getOpenPos(sku) : store.getAllPos().filter((p) => !['received', 'cancelled'].includes(p.status));
      return pos.map(summarizePo);
    },

    // Dry-run a what-if supply plan without writing anything.
    simulate_purchase_plan({ sku, daily_demand, extra_orders }) {
      const extraArrivals = (extra_orders || []).map((o) => ({
        po_id: o.po_id || 'PROPOSED',
        day: o.arrives_in_days,
        qty: o.quantity,
      }));
      const sim = simulateCoverage(sku, {
        dailyDemand: daily_demand ?? undefined,
        extraArrivals,
      });
      return {
        projection: {
          stockout_day: sim.stockout_day,
          below_safety_day: sim.below_safety_day,
          end_stock: sim.end_stock,
          unmet_gap: sim.unmet_gap,
          total_incoming: sim.total_incoming,
          total_demand: sim.total_demand,
        },
        daily: sim.daily,
      };
    },

    // ── Action tools (validation-gated) ──────────────────────────────────

    create_purchase_order({ sku, supplier_id, quantity, justification }) {
      log('action_attempt', { action: 'create_po', sku, supplier_id, quantity });
      const check = validateCreatePo({ sku, supplier_id, quantity });
      if (!check.ok) {
        log('validation_failed', { action: 'create_po', violations: check.violations });
        return { success: false, rejected_by_validator: true, violations: check.violations, warnings: check.warnings };
      }

      const config = store.getConfig();
      const value = check.value;
      const needsApproval = value > config.approvalThresholdUsd;

      const po = store.addPo({
        id: store.nextPoId(),
        sku,
        supplier_id,
        quantity: check.qty,
        unit_price: check.supplier.unit_price,
        status: needsApproval ? 'pending_approval' : 'confirmed',
        expected_in_days: check.supplier.lead_time_days,
        expected_date: new Date(Date.now() + check.supplier.lead_time_days * 86400000).toISOString().slice(0, 10),
        created_in_days_ago: 0,
        note: justification || 'Created by AI purchasing agent',
      });

      const verification = verifyCreatePo(po, { quantity: check.qty, supplier_id });
      log('action_executed', { action: 'create_po', po_id: po.id, quantity: po.quantity, status: po.status });
      log('verification', { po_id: po.id, verified: verification.verified, checks: verification.checks });

      return {
        success: true,
        purchase_order: summarizePo(po),
        required_human_approval: needsApproval,
        approval_note: needsApproval
          ? `Order value $${value} exceeds the $${config.approvalThresholdUsd} approval threshold — PO created in PENDING_APPROVAL state and routed to the buyer's approval inbox`
          : null,
        verification,
        warnings: check.warnings,
      };
    },

    modify_purchase_order({ po_id, new_quantity, reason }) {
      log('action_attempt', { action: 'modify_po', po_id, new_quantity });
      const check = validateModifyPo({ po_id, new_quantity });
      if (!check.ok) {
        log('validation_failed', { action: 'modify_po', po_id, violations: check.violations });
        return { success: false, rejected_by_validator: true, violations: check.violations, warnings: check.warnings };
      }

      const oldQty = check.po.quantity;
      const po = store.updatePo(po_id, { quantity: check.qty });
      const verification = verifyModifyPo(po_id, check.qty);
      log('action_executed', { action: 'modify_po', po_id, oldQty, new_quantity: check.qty });
      log('verification', { po_id, verified: verification.verified, checks: verification.checks });

      return {
        success: true,
        purchase_order: summarizePo(po),
        changed_from: oldQty,
        changed_to: check.qty,
        reason: reason || null,
        verification,
        warnings: check.warnings,
      };
    },

    cancel_purchase_order({ po_id, reason }) {
      log('action_attempt', { action: 'cancel_po', po_id });
      const check = validateCancelPo({ po_id });
      if (!check.ok) {
        log('validation_failed', { action: 'cancel_po', po_id, violations: check.violations });
        return { success: false, rejected_by_validator: true, violations: check.violations, warnings: check.warnings };
      }
      store.updatePo(po_id, { status: 'cancelled', note: `${check.po.note || ''} — cancelled: ${reason || 'agent decision'}`.trim() });
      log('action_executed', { action: 'cancel_po', po_id });
      return { success: true, purchase_order: summarizePo(store.getPo(po_id)) };
    },

    escalate_to_human({ title, summary, proposed_plan }) {
      const escalation = {
        id: `ESC-${Math.floor(Math.random() * 900 + 100)}`,
        title,
        summary,
        proposed_plan: proposed_plan || null,
        status: 'open',
      };
      store.addEvent({ type: 'escalation', ...escalation });
      log('escalation', escalation);
      return { success: true, escalation };
    },
  };

  return handlers;
}

// OpenAI-style tool schemas served to the LLM brain.
export function toolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'get_product_overview',
        description: 'Get full picture for a SKU: inventory, forecast, open POs, and a 14-day coverage projection (stockout day, unmet gap).',
        parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_sales_history',
        description: 'Get recent daily sales (actual vs forecast) for a SKU, with 7-day trend vs forecast. Use to verify demand assumptions before acting.',
        parameters: { type: 'object', properties: { sku: { type: 'string' }, days: { type: 'number' } }, required: ['sku'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_suppliers',
        description: 'List suppliers for a SKU with lead time, MOQ, price, max order size, reliability. Also returns available budget.',
        parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_budget',
        description: 'Get purchasing budget summary: total, spent, committed to open POs, and available.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_storage_status',
        description: 'Get warehouse storage: capacity, used, inbound, projected peak.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_open_purchase_orders',
        description: 'List open purchase orders (optionally for one SKU) with quantities, suppliers, delivery dates, status.',
        parameters: { type: 'object', properties: { sku: { type: 'string' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'simulate_purchase_plan',
        description: 'Dry-run a what-if supply plan: project stock day-by-day given an assumed daily demand and hypothetical extra orders. No data is written.',
        parameters: {
          type: 'object',
          properties: {
            sku: { type: 'string' },
            daily_demand: { type: 'number', description: 'Assumed daily demand; omit to use current forecast' },
            extra_orders: {
              type: 'array',
              description: 'Hypothetical orders to include in the projection',
              items: {
                type: 'object',
                properties: { quantity: { type: 'number' }, arrives_in_days: { type: 'number' }, po_id: { type: 'string' } },
              },
            },
          },
          required: ['sku'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_purchase_order',
        description: 'Create a purchase order. Goes through an independent validation gate (MOQ, supplier capacity, budget, storage, duplicates, lead time). May require human approval depending on order value. Returns verification of the written result.',
        parameters: {
          type: 'object',
          properties: {
            sku: { type: 'string' },
            supplier_id: { type: 'string' },
            quantity: { type: 'number' },
            justification: { type: 'string' },
          },
          required: ['sku', 'supplier_id', 'quantity'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'modify_purchase_order',
        description: 'Change the quantity of an open purchase order. Validation-gated; returns verification of the written result.',
        parameters: {
          type: 'object',
          properties: { po_id: { type: 'string' }, new_quantity: { type: 'number' }, reason: { type: 'string' } },
          required: ['po_id', 'new_quantity'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_purchase_order',
        description: 'Cancel an open purchase order. Validation-gated.',
        parameters: { type: 'object', properties: { po_id: { type: 'string' }, reason: { type: 'string' } }, required: ['po_id'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'escalate_to_human',
        description: 'Escalate a situation to the human buyer with a summary and a proposed plan. Use when constraints cannot be satisfied, when the agent is not confident, or when a decision exceeds its authority.',
        parameters: {
          type: 'object',
          properties: { title: { type: 'string' }, summary: { type: 'string' }, proposed_plan: { type: 'string' } },
          required: ['title', 'summary'],
        },
      },
    },
  ];
}

export { recommendedQty };
