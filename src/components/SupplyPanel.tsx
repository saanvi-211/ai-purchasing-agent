import type { WorldState } from '../types';

function pct(a: number, b: number): string {
  if (!b) return '0%';
  return `${Math.round((a / b) * 100)}%`;
}

export function SupplyPanel({ state }: { state: WorldState | null }) {
  if (!state) return <section className="panel"><p className="empty-hint">Loading…</p></section>;

  const coffee = state.inventory.find((i) => i.sku === 'SKU-COFFEE-1L');
  const fc = state.forecast.find((f) => f.sku === 'SKU-COFFEE-1L');

  return (
    <section className="panel supply-panel">
      <div className="panel-head">
        <h2>Supply snapshot</h2>
      </div>

      <div className="metrics-row">
        <div className="metric">
          <span className="metric-label">Budget available</span>
          <span className="metric-value">${state.budget.available.toLocaleString()}</span>
          <span className="metric-sub">
            of ${state.budget.total.toLocaleString()} · committed ${state.budget.committed.toLocaleString()}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Storage projected peak</span>
          <span className="metric-value">{pct(state.storage.projected_peak_units, state.storage.capacity_units)}</span>
          <span className="metric-sub">
            {state.storage.projected_peak_units} / {state.storage.capacity_units} units
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Coffee on hand</span>
          <span className="metric-value">{coffee ? coffee.on_hand : '—'}</span>
          <span className="metric-sub">
            safety {coffee?.safety_stock} · {fc?.daily_expected}/day forecast
          </span>
        </div>
      </div>

      <h3 className="section-sub">Open purchase orders</h3>
      <table className="po-table">
        <thead>
          <tr>
            <th>PO</th>
            <th>SKU</th>
            <th>Supplier</th>
            <th>Qty</th>
            <th>ETA</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {state.purchase_orders.map((po) => (
            <tr key={po.id} className={`po-status-${po.status}`}>
              <td>{po.id}</td>
              <td>{po.sku.replace('SKU-', '')}</td>
              <td>{state.suppliers.find((s) => s.id === po.supplier_id)?.name || po.supplier_id}</td>
              <td>
                {po.quantity}
                {po.original_quantity && <span className="po-orig"> (of {po.original_quantity})</span>}
              </td>
              <td>{po.status === 'received' ? '—' : `in ${po.expected_in_days}d`}</td>
              <td>
                <span className={`status-pill st-${po.status}`}>{po.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {state.events.length > 0 && (
        <>
          <h3 className="section-sub">Recent events</h3>
          <ul className="event-list">
            {state.events.slice(0, 5).map((e, i) => (
              <li key={i}>
                <span className={`event-type ev-${e.type}`}>{e.type.replace('_', ' ')}</span> {e.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
