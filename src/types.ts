// Shared types for the agent API.

export type DecisionType = 'accept' | 'modify' | 'reject' | 'investigate' | 'escalate';

export interface Factor {
  factor: string;
  impact: 'positive' | 'negative' | 'neutral';
  detail: string;
}

export interface AgentDecision {
  decision: DecisionType;
  headline: string;
  factors: Factor[];
  actions_taken: string[];
  proposed_plan: string | null;
  confidence: number;
  validation: string;
}

export interface TraceEvent {
  type: string;
  source?: string;
  name?: string;
  args?: any;
  result?: any;
  text?: string;
  data?: any;
  message?: string;
  po_id?: string;
  verified?: boolean;
  checks?: { check: string; pass: boolean; detail: string }[];
  violations?: { rule: string; message: string }[];
  action?: string;
  quantity?: number;
  status?: string;
  [key: string]: any;
}

export interface CoverageOutcome {
  stockout_day: number | null;
  below_safety_day: number | null;
  end_stock: number;
  unmet_gap: number;
  stockout_risk: string;
}

export interface PurchaseOrder {
  id: string;
  sku: string;
  supplier_id: string;
  quantity: number;
  original_quantity?: number;
  unit_price: number;
  status: string;
  expected_in_days: number;
  expected_date: string;
  note?: string;
}

export interface WorldState {
  products: { sku: string; name: string; unit_cost: number; category: string }[];
  inventory: { sku: string; on_hand: number; reserved: number; safety_stock: number }[];
  purchase_orders: PurchaseOrder[];
  suppliers: {
    id: string;
    name: string;
    skus: string[];
    lead_time_days: number;
    moq: number;
    unit_price: number;
    max_order_qty: number;
    reliability: number;
    notes: string;
  }[];
  budget: { period: string; total: number; spent: number; committed: number; available: number };
  storage: { capacity_units: number; used_units: number; incoming_units: number; projected_peak_units: number };
  events: { type: string; at: string; message: string }[];
  forecast: { sku: string; daily_expected: number }[];
}

export interface Scenario {
  id: string;
  name: string;
  kind: string;
  sku: string;
  recommendation: { sku: string; quantity: number; supplier_id?: string } | null;
  task: string;
}

export interface EvaluationCheck {
  check: string;
  pass: boolean;
  detail: string;
}

export interface EvaluationResult {
  id: string;
  name: string;
  passed: boolean;
  checks: EvaluationCheck[];
  decision: { decision: string; headline: string; actions_taken: string[]; validation: string };
}

export interface EvaluationReport {
  ranAt: string;
  totals: { passed: number; failed: number; total: number };
  results: EvaluationResult[];
}
