import { chatCompletion, llmConfigured } from './llm.js';
import { buildSystemPrompt, extractJson } from './prompt.js';

// LLM agent brain: an OpenAI-compatible tool-calling loop. The model
// investigates via tools, must pass through the validation gate for any
// action, and must finish with the structured decision JSON.
export async function runLlmBrain({ sku, recommendation, task, handlers, schemas, emit }) {
  const systemPrompt = buildSystemPrompt({ sku, recommendation });

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `${task}\n\nInvestigate with the tools, then take actions if appropriate, then produce your final decision JSON.`,
    },
  ];

  const MAX_ITERATIONS = 14;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const resp = await chatCompletion({ messages, tools: schemas });

    if (resp.tool_calls && resp.tool_calls.length) {
      messages.push({
        role: 'assistant',
        content: resp.content || null,
        tool_calls: resp.tool_calls,
      });

      for (const call of resp.tool_calls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        emit({ type: 'tool_call', source: 'llm', name, args });

        let result;
        try {
          const handler = handlers[name];
          if (!handler) result = { error: `Unknown tool ${name}` };
          else result = await handler(args);
        } catch (err) {
          result = { error: err.message };
        }

        emit({ type: 'tool_result', source: 'llm', name, result });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 6000),
        });
      }
      continue;
    }

    if (resp.content) {
      const parsed = extractJson(resp.content);
      if (parsed) {
        emit({ type: 'thought', source: 'llm', text: 'Final decision reached.' });
        return parsed;
      }
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({
        role: 'user',
        content:
          'That was not the required format. Reply with ONLY the final decision JSON object matching the output contract.',
      });
      continue;
    }
  }

  throw new Error('Agent did not reach a final decision within the iteration limit');
}

export { llmConfigured };
