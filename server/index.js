import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as store from './store.js';
import { SCENARIOS } from './scenarios.js';
import { runAgentScenario } from './agent/run.js';
import { runEvaluation } from './evaluation.js';
import { llmInfo } from './agent/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/state', (req, res) => {
  res.json({
    products: store.getWorld().products,
    inventory: store.getWorld().inventory,
    purchase_orders: store.getAllPos(),
    suppliers: store.getWorld().suppliers,
    budget: store.getBudgetSummary(),
    storage: store.getStorageSummary(),
    events: store.getWorld().events.slice(0, 10),
    forecast: store.getWorld().forecast,
  });
});

app.get('/api/scenarios', (req, res) => {
  res.json(
    SCENARIOS.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      sku: s.sku,
      recommendation: s.recommendation,
      task: s.task,
    }))
  );
});

app.get('/api/llm', (req, res) => res.json(llmInfo()));

app.post('/api/reset', (req, res) => {
  store.resetWorld();
  res.json({ ok: true });
});

// Buyer approval inbox actions.
app.post('/api/approvals/:poId/:action', (req, res) => {
  const { poId, action } = req.params;
  const po = store.getPo(poId);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'pending_approval') return res.status(400).json({ error: `PO ${poId} is ${po.status}, not pending approval` });

  if (action === 'approve') {
    store.updatePo(poId, { status: 'confirmed' });
    store.addEvent({ type: 'approval', message: `Buyer approved ${poId} (${po.quantity} units)` });
  } else if (action === 'reject') {
    store.updatePo(poId, { status: 'rejected', note: `${po.note || ''} — rejected by buyer`.trim() });
    store.addEvent({ type: 'approval', message: `Buyer rejected ${poId}` });
  } else {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }
  res.json({ ok: true, purchase_order: po });
});

// ── Agent run (SSE stream of the trace) ──────────────────────────────────────

app.post('/api/agent/run', async (req, res) => {
  const { scenarioId, brain } = req.body || {};
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    await runAgentScenario({ scenarioId, brain, emit: send });
  } catch (err) {
    send({ type: 'error', message: err.message });
    send({ type: 'done', decision: null, mode: 'error', outcome: null });
  }
  res.end();
});

// ── Evaluation ───────────────────────────────────────────────────────────────

app.get('/api/evaluation/run', async (req, res) => {
  try {
    const report = await runEvaluation();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Static frontend (production) ─────────────────────────────────────────────

const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Purchasing Agent server listening on port ${PORT}`);
  console.log(`LLM brain: ${llmInfo().configured ? `configured (${llmInfo().model})` : 'not configured — rule brain will be used'}`);
});
