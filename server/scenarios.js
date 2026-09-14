// Scenario definitions. Each scenario resets the mock ERP to the base world,
// applies an overlay (setup data + incoming events), and hands the agent a task.

export const SCENARIOS = [
  {
    id: 'scenario-1',
    kind: 'recommendation_review',
    name: 'Scenario 1 — Purchase Recommendation Review',
    sku: 'SKU-COFFEE-1L',
    recommendation: { sku: 'SKU-COFFEE-1L', quantity: 800, supplier_id: 'SUP-A' },
    task:
      'The purchasing system recommends buying 800 units of Cold Brew Coffee 1L from NordicRoast Foods. ' +
      'Review the recommendation against inventory, expected demand, open purchase orders, supplier terms, ' +
      'budget and storage. Decide: accept, modify, reject, or investigate further — and explain the factors.',
    overlay(world) {
      world.events.unshift({
        type: 'recommendation',
        at: new Date().toISOString(),
        message: 'Replenishment engine recommends ordering 800 units of SKU-COFFEE-1L from SUP-A.',
      });
    },
  },
  {
    id: 'scenario-2',
    kind: 'partial_supply',
    name: 'Scenario 2 — Supplier Cannot Fulfil the Purchase',
    sku: 'SKU-COFFEE-1L',
    recommendation: null,
    task:
      'Purchase order PO-1077 was created for 500 units from Baltic Beverage Co, but the supplier just ' +
      'informed the system they can currently only supply 250 units. Decide what should happen next: source ' +
      'the remainder elsewhere, wait, use existing inventory, or escalate — and act accordingly.',
    overlay(world) {
      const now = new Date();
      const iso = (d) => new Date(now.getTime() + d * 86400000).toISOString().slice(0, 10);
      // The previous weekly replenishment (PO-1042) has already been received
      // and sold down; PO-1077 (500u from SUP-B) is now the only inbound order,
      // and the supplier can only fulfil half of it.
      world.inventory.find((i) => i.sku === 'SKU-COFFEE-1L').on_hand = 250;
      const po1042 = world.purchase_orders.find((p) => p.id === 'PO-1042');
      po1042.status = 'received';
      po1042.note = 'Received last week';
      world.purchase_orders.push({
        id: 'PO-1077',
        sku: 'SKU-COFFEE-1L',
        supplier_id: 'SUP-B',
        quantity: 250,
        original_quantity: 500,
        unit_price: 12.6,
        status: 'partial',
        expected_in_days: 7,
        expected_date: iso(7),
        created_in_days_ago: 4,
        note: 'Supplier can only fulfil 250 of 500 units (shortfall message received today)',
      });
      world.events.unshift({
        type: 'supplier_message',
        at: new Date().toISOString(),
        message: 'Baltic Beverage Co (SUP-B): "We can only supply 250 of the 500 units on PO-1077 right now."',
      });
    },
  },
  {
    id: 'scenario-3',
    kind: 'demand_surge',
    name: 'Scenario 3 — Demand / Forecast Has Changed',
    sku: 'SKU-COFFEE-1L',
    recommendation: null,
    task:
      'Cold Brew Coffee 1L was planned at ~45 units/day, but actual sales have increased significantly over ' +
      'the past week. There is an existing purchase order inbound, but current inventory plus incoming ' +
      'quantity may no longer cover expected demand. Investigate whether the sales lift is real, decide ' +
      'whether the purchasing plan needs to change, and act on the evidence.',
    overlay(world) {
      // Rewrite the last 7 days of coffee sales with a sustained lift (62–75 vs 45 forecast).
      const rows = world.sales_history.filter((r) => r.sku === 'SKU-COFFEE-1L');
      const lifts = [64, 71, 68, 75, 66, 72, 69];
      rows.slice(-7).forEach((r, idx) => {
        r.actual = lifts[idx];
      });
      world.events.unshift({
        type: 'alert',
        at: new Date().toISOString(),
        message: 'Demand monitor: SKU-COFFEE-1L sales are running well above forecast for the past week.',
      });
    },
  },
  {
    id: 'scenario-4',
    kind: 'constraint_blocked',
    name: 'Scenario 4 — Purchasing Constraint',
    sku: 'SKU-COFFEE-1L',
    recommendation: { sku: 'SKU-COFFEE-1L', quantity: 400, supplier_id: 'SUP-A' },
    task:
      'You have determined that ~180 units of Cold Brew Coffee 1L should be purchased (coverage gap within ' +
      'the planning horizon). A recommendation of 400 units is on the table. However, budget and storage ' +
      'constraints may prevent the recommended purchase from being executed as-is. Determine an appropriate ' +
      'course of action rather than blindly executing the recommendation.',
    overlay(world) {
      // Budget: only $1,800 available (total 50,000 − spent 41,570 − committed open POs).
      world.budget.spent = 41570;
      // Storage: capacity reduced by other goods occupying the warehouse.
      world.storage.capacity_units = 2200;
      world.events.unshift({
        type: 'recommendation',
        at: new Date().toISOString(),
        message: 'Replenishment engine recommends ordering 400 units of SKU-COFFEE-1L from SUP-A.',
      });
    },
  },
];

export function getScenario(id) {
  return SCENARIOS.find((s) => s.id === id);
}
