import { getWorld, getInventory, getForecast, getOpenPos } from './store.js';

// Forward coverage projection: walks day-by-day through the planning horizon,
// subtracting daily demand and adding inbound PO deliveries on their expected day.
// Used by the agent (dry-run tool) and by the validator (post-action verification).

export function simulateCoverage(sku, options = {}) {
  const world = getWorld();
  const horizon = options.horizonDays || world.config.horizonDays;
  const inv = getInventory(sku);
  const forecast = getForecast(sku);

  const dailyDemand =
    options.dailyDemand ??
    options.adjustedDemand ??
    forecast?.daily_expected ??
    0;

  const startOnHand = (inv?.on_hand ?? 0) - (inv?.reserved ?? 0);
  const safetyStock = inv?.safety_stock ?? 0;

  const arrivals = [];
  for (const po of getOpenPos(sku)) {
    if (['open', 'confirmed', 'in_transit', 'pending_approval', 'partial'].includes(po.status)) {
      arrivals.push({ po_id: po.id, day: Math.max(1, po.expected_in_days), qty: po.quantity });
    }
  }
  if (options.extraArrivals) arrivals.push(...options.extraArrivals);

  let stock = startOnHand;
  const daily = [];
  let stockoutDay = null;
  let belowSafetyDay = null;
  let minStock = stock;

  for (let day = 1; day <= horizon; day++) {
    const arriving = arrivals.filter((a) => a.day === day).reduce((s, a) => s + a.qty, 0);
    stock += arriving;
    stock -= dailyDemand;
    if (stock < minStock) minStock = stock;
    if (stock < 0 && stockoutDay === null) stockoutDay = day;
    if (stock < safetyStock && belowSafetyDay === null) belowSafetyDay = day;
    daily.push({ day, arriving, demand: dailyDemand, end_stock: Math.round(stock) });
  }

  const totalDemand = dailyDemand * horizon;
  const totalIncoming = arrivals.reduce((s, a) => s + a.qty, 0);
  const requiredSupply = totalDemand + safetyStock - startOnHand;
  const gap = Math.max(0, requiredSupply - totalIncoming);

  return {
    sku,
    horizon_days: horizon,
    daily_demand: dailyDemand,
    start_on_hand: startOnHand,
    safety_stock: safetyStock,
    arrivals,
    daily,
    stockout_day: stockoutDay,
    below_safety_day: belowSafetyDay,
    end_stock: Math.round(stock),
    min_stock: Math.round(minStock),
    total_demand: totalDemand,
    total_incoming: totalIncoming,
    required_supply: Math.round(requiredSupply),
    unmet_gap: Math.round(gap),
    stockout_risk: stockoutDay !== null ? 'high' : belowSafetyDay !== null ? 'medium' : 'low',
  };
}

// Recommended order quantity to close the coverage gap, rounded up to the
// supplier's MOQ when a supplier is given.
export function recommendedQty(sim, supplier) {
  let qty = sim.unmet_gap;
  if (supplier && qty > 0) qty = Math.max(qty, supplier.moq);
  return Math.round(qty);
}
