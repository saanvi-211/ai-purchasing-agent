import type { WorldState } from '../types';

export function ApprovalsPanel({
  state,
  onApprove,
  onReject,
  busy,
}: {
  state: WorldState | null;
  onApprove: (poId: string) => void;
  onReject: (poId: string) => void;
  busy: boolean;
}) {
  const pending = state?.purchase_orders.filter((p) => p.status === 'pending_approval') || [];

  return (
    <section className="panel approvals-panel">
      <div className="panel-head">
        <h2>Approval inbox</h2>
        {pending.length > 0 && <span className="pending-count">{pending.length}</span>}
      </div>
      {pending.length === 0 ? (
        <p className="empty-hint">
          No orders awaiting approval. Orders above the $5,000 threshold land here for the buyer to approve or reject.
        </p>
      ) : (
        <ul className="approval-list">
          {pending.map((po) => (
            <li key={po.id} className="approval-item">
              <div className="approval-info">
                <strong>{po.id}</strong> — {po.quantity} units · ${Math.round(po.quantity * po.unit_price).toLocaleString()}
                <div className="approval-note">{po.note}</div>
              </div>
              <div className="approval-actions">
                <button className="btn btn-approve" disabled={busy} onClick={() => onApprove(po.id)}>
                  Approve
                </button>
                <button className="btn btn-reject" disabled={busy} onClick={() => onReject(po.id)}>
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
