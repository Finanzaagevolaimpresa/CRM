import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWorkflowPreparationInput } from '../src/lib/workflow-runner-command';

async function* chunks(...values: Array<string | Uint8Array>) { yield* values; }
const token = 'synthetic-input-only-not-a-registered-session';
test('one-shot input accepts a token only on bounded stdin and rejects identity substitutes', async () => {
  assert.deepEqual(await readWorkflowPreparationInput(chunks('{"sessionToken":', JSON.stringify(token) + '}')),
    { sessionToken: token, limit: 20 });
  for (const body of [{ userId: 'admin', sessionId: 'claimed' }, { sessionToken: token, userId: 'admin' },
    { sessionToken: token, limit: 51 }, { sessionToken: token, replyTo: 'sender@invalid.test' }])
    await assert.rejects(readWorkflowPreparationInput(chunks(JSON.stringify(body))));
});
test('one-shot input rejects invalid UTF8, oversized and empty streams', async () => {
  await assert.rejects(readWorkflowPreparationInput(chunks(Buffer.from([0xc0, 0xaf]))));
  await assert.rejects(readWorkflowPreparationInput(chunks(' '.repeat(16_385))));
  await assert.rejects(readWorkflowPreparationInput(chunks()));
});
