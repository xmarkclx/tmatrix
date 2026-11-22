import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { promptFixture } from '../test/fixtures/prompt-ticket.ts';
const checkout = process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url));
const { TicketRunner } = await import(pathToFileURL(`${checkout}/src/runner.ts`).href);
const { nullLogger } = await import(pathToFileURL(`${checkout}/src/logger.ts`).href);
const { Metrics } = await import(pathToFileURL(`${checkout}/src/metrics.ts`).href);
const rows = [];
for (const commentCount of [0, 12]) {
  const { ticket, history } = promptFixture(commentCount);
  let prepared;
  const runner = new TicketRunner({
    api: { markTaken: async () => {}, getHistory: async () => history, reportProgress: async () => {}, reportResult: async () => {} },
    logger: nullLogger(), metrics: new Metrics(),
    codexFactory: () => ({ startThread: () => ({ runStreamed: async prompt => {
      prepared = prompt;
      return { events: (async function* () {
        yield { type: 'item.completed', item: { id: 'result', type: 'agent_message', text: JSON.stringify({ outcome: 'AI_DONE', context_summary: 'Synthetic measurement only.', user_message: 'Synthetic measurement only.' }) } };
        yield { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } };
      })() };
    } }) })
  });
  const result = await runner.run(ticket, { runId: 'measurement', recovered: false });
  if (result.status !== 'completed' || typeof prepared !== 'string') throw new Error('Actual runner did not prepare the measurement prompt');
  rows.push({ commentCount, instructions_chars: ticket.instructions.length, prompt_chars: prepared.length,
    prompt_utf8_bytes: Buffer.byteLength(prepared), description_occurrences: prepared.split('TASK_DESCRIPTION:').length - 1,
    saved_handoff_occurrences: prepared.split('SAVED_HANDOFF:').length - 1 });
}
const output = JSON.stringify(rows, null, 2) + '\n';
if (process.argv[3]) await writeFile(process.argv[3], output);
process.stdout.write(output);
