import { buildBaseWorld, CONFIG } from './seed.js';

// In-memory mock ERP. A real deployment would swap this for a database;
// the agent and validator only talk to it through the functions below.

let world = buildBaseWorld();

export function resetWorld(scenarioOverlay) {
  world = buildBaseWorld();
  if (scenarioOverlay) scenarioOverlay(world);
  return world;
}

export function getWorld() {
  return world;
}

export function getConfig() {
  return world.config || CONFIG;
}

export function getBudgetSummary() {
  const committed = world.purchase_orders
    .filter((po) => ['open', 'confirmed', 'in_transit', 'pending_approval', 'partial'].includes(po.status))
    .reduce((sum, po) => sum + po.quantity * po.unit_price, 0);
  const available = world.budget.total - world.budget.spent - committed;
  return {
    period: world.budget.period,
    total: world.budget.total,
    spent: world.budget.spent,
    committed: Math.round(committed),
    available: Math.round(available),
  };
}

export function getStorageSummary() {
  const used = world.inventory.reduce((sum, i) => sum + i.on_hand, 0);
  const incoming = world.purchase_orders
    .filter((po) => ['confirmed', 'in_transit', 'partial'].includes(po.status))
    .reduce((sum, po) => sum + po.quantity, 0);
  return {
    capacity_units: world.storage.capacity_units,
    used_units: used,
    incoming_units: incoming,
    // Peak usage if everything currently inbound is received before anything sells.
    projected_peak_units: used + incoming,
  };
}

export function getInventory(sku) {
  return world.inventory.find((i) => i.sku === sku);
}

export function getForecast(sku) {
  return world.forecast.find((f) => f.sku === sku);
}

export function getSalesHistory(sku, days = 28) {
  return world.sales_history
    .filter((r) => r.sku === sku && r.day_offset >= -days)
    .sort((a, b) => a.day_offset - b.day_offset);
}

export function getProduct(sku) {
  return world.products.find((p) => p.sku === sku);
}

export function getSupplier(supplierId) {
  return world.suppliers.find((s) => s.id === supplierId);
}

export function getSuppliersForSku(sku) {
  return world.suppliers.filter((s) => s.skus.includes(sku));
}

export function getOpenPos(sku) {
  return world.purchase_orders.filter(
    (po) => po.sku === sku && !['received', 'cancelled', 'rejected'].includes(po.status)
  );
}

export function getAllPos() {
  return world.purchase_orders;
}

export function getPo(poId) {
  return world.purchase_orders.find((po) => po.id === poId);
}

export function nextPoId() {
  return `PO-${world.nextPoNumber++}`;
}

export function addPo(po) {
  world.purchase_orders.push(po);
  return po;
}

export function updatePo(poId, patch) {
  const po = getPo(poId);
  if (!po) return null;
  Object.assign(po, patch);
  return po;
}

export function addEvent(event) {
  world.events.unshift({ ...event, at: new Date().toISOString() });
}

export function setInventory(sku, patch) {
  const inv = getInventory(sku);
  if (inv) Object.assign(inv, patch);
}

export function setForecast(sku, patch) {
  const fc = getForecast(sku);
  if (fc) Object.assign(fc, patch);
}
