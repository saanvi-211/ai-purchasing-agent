// Base mock-ERP world. Every scenario run rebuilds this world from scratch and
// applies a scenario overlay on top, so runs are deterministic and repeatable.

export const CONFIG = {
  approvalThresholdUsd: 2500, // POs above this need human approval
  horizonDays: 14,            // planning horizon used everywhere
  maxAgentRetries: 3,         // agent retries after a failed validation
};

function salesSeries(sku, dailyForecast, actualFn) {
  const rows = [];
  for (let d = 28; d >= 1; d--) {
    rows.push({
      sku,
      day_offset: -d,
      forecast: dailyForecast,
      actual: actualFn(d),
    });
  }
  return rows;
}

export function buildBaseWorld() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const dateIn = (days) => new Date(now + days * day).toISOString().slice(0, 10);

  return {
    createdAt: now,
    config: CONFIG,
    products: [
      { sku: 'SKU-COFFEE-1L', name: 'Cold Brew Coffee 1L', unit_cost: 12.0, category: 'Coffee' },
      { sku: 'SKU-GREEN-TEA', name: 'Green Tea 500ml', unit_cost: 6.5, category: 'Tea' },
      { sku: 'SKU-COCOA-500', name: 'Cocoa 500ml', unit_cost: 9.0, category: 'Cocoa' },
    ],
    inventory: [
      { sku: 'SKU-COFFEE-1L', on_hand: 220, reserved: 20, safety_stock: 150 },
      { sku: 'SKU-GREEN-TEA', on_hand: 640, reserved: 40, safety_stock: 200 },
      { sku: 'SKU-COCOA-500', on_hand: 410, reserved: 10, safety_stock: 120 },
    ],
    // Daily sales vs forecast for the last 28 days.
    sales_history: [
      ...salesSeries('SKU-COFFEE-1L', 45, () => 43 + Math.round(Math.sin(1) * 2)),
      ...salesSeries('SKU-GREEN-TEA', 55, (d) => 52 + (d % 5)),
      ...salesSeries('SKU-COCOA-500', 30, (d) => 28 + (d % 4)),
    ],
    forecast: [
      { sku: 'SKU-COFFEE-1L', daily_expected: 45, horizon_days: 14, source: 'baseline-v3' },
      { sku: 'SKU-GREEN-TEA', daily_expected: 55, horizon_days: 14, source: 'baseline-v3' },
      { sku: 'SKU-COCOA-500', daily_expected: 30, horizon_days: 14, source: 'baseline-v3' },
    ],
    suppliers: [
      {
        id: 'SUP-A',
        name: 'NordicRoast Foods',
        skus: ['SKU-COFFEE-1L'],
        lead_time_days: 5,
        moq: 250,
        unit_price: 12.0,
        max_order_qty: 1000,
        reliability: 0.95,
        notes: 'Primary supplier. Very reliable, average lead time.',
      },
      {
        id: 'SUP-B',
        name: 'Baltic Beverage Co',
        skus: ['SKU-COFFEE-1L', 'SKU-GREEN-TEA'],
        lead_time_days: 8,
        moq: 150,
        unit_price: 12.6,
        max_order_qty: 600,
        reliability: 0.88,
        notes: 'Secondary supplier. Cheaper than expedite, slower than primary.',
      },
      {
        id: 'SUP-C',
        name: 'SwiftSupply Traders',
        skus: ['SKU-COFFEE-1L'],
        lead_time_days: 2,
        moq: 100,
        unit_price: 14.1,
        max_order_qty: 300,
        reliability: 0.72,
        notes: 'Expediting option. Fast but expensive and less reliable.',
      },
    ],
    purchase_orders: [
      {
        id: 'PO-1042',
        sku: 'SKU-COFFEE-1L',
        supplier_id: 'SUP-A',
        quantity: 400,
        unit_price: 12.0,
        status: 'confirmed',
        expected_in_days: 5,
        expected_date: dateIn(5),
        created_in_days_ago: 3,
        note: 'Regular weekly replenishment',
      },
      {
        id: 'PO-1043',
        sku: 'SKU-GREEN-TEA',
        supplier_id: 'SUP-B',
        quantity: 300,
        unit_price: 6.1,
        status: 'in_transit',
        expected_in_days: 3,
        expected_date: dateIn(3),
        created_in_days_ago: 6,
        note: 'Tea replenishment',
      },
    ],
    budget: {
      period: '2026-09',
      total: 50000,
      spent: 31000,
      // committed is computed dynamically from open POs
    },
    storage: {
      capacity_units: 3000,
      // used is computed dynamically from on-hand inventory
    },
    events: [], // supplier messages / system events appended by scenarios
    nextPoNumber: 1100,
  };
}
