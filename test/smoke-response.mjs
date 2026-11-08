// Offline test for response capture: the stream is forwarded unchanged, the
// reply is assembled with the harness's own block rules, and an aborted stream
// keeps exactly what was delivered.
//
//   node test/smoke-response.mjs
//
// Runs in a throwaway DSH_HOME; the real profile is never touched.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-resp-'));
process.env.DSH_HOME = home;
const dumps = join(home, 'dumps');
mkdirSync(join(home, 'llm-dumps'), { recursive: true });
writeFileSync(join(home, 'llm-dumps', 'config.json'), JSON.stringify({ outputDir: dumps }));

const { apply } = await import('../lib/index.js');

const failures = [];
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : ` (${JSON.stringify(actual)})`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(path, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim());
      if (lines.length >= count) return lines.map((line) => JSON.parse(line));
    }
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${count} rows in ${path}`);
}

const handlers = new Map();
apply({
  on(name, fn) {
    handlers.set(name, fn);
  },
  logger: { warn: (error) => console.error('[warn]', error) },
});
const hook = handlers.get('llm/stream');
check('registers the llm/stream hook', typeof hook, 'function');

const streamOf = (chunks) =>
  (async function* () {
    for (const chunk of chunks) yield chunk;
  })();

async function pass(options, chunks, { stopEarly = false } = {}) {
  const seen = [];
  for await (const chunk of hook(options, () => streamOf(chunks))) {
    seen.push(chunk);
    if (stopEarly && seen.length === 2) break;
  }
  return seen;
}

const system = { role: 'system', content: [{ type: 'text', text: 'be brief' }] };
const user1 = { role: 'user', content: [{ type: 'text', text: '你好' }], id: 'u1' };
const reply1 = { role: 'assistant', content: [{ type: 'text', text: '第一次回复' }], id: 'a1' };
const user2 = { role: 'user', content: [{ type: 'text', text: '继续' }], id: 'u2' };

const first = await pass({ sessionId: 'smoke-resp', provider: 'p', model: 'm', messages: [system, user1] }, [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '第一次' },
  { type: 'text-delta', index: 0, text: '回复' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '第一次回复' } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
  { type: 'finish', reason: { kind: 'stop' } },
]);
check('forwards every chunk', first.length, 6);

const second = await pass(
  { sessionId: 'smoke-resp', provider: 'p', model: 'm', messages: [system, user1, reply1, user2] },
  [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '想一想' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '最新回复：' },
    { type: 'text-delta', index: 1, text: '已完成' },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'read', argumentsDelta: '{"path":' },
    { type: 'tool-call-delta', index: 2, id: 'call_1', argumentsDelta: '"a.txt"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
);
check('forwards every chunk (2)', second.length, 9);

// A consumer that stops early must still produce an interrupted record.
await pass(
  { sessionId: 'smoke-abort', provider: 'p', model: 'm', messages: [system, user1] },
  [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '截断的' },
    { type: 'text-delta', index: 0, text: '回复' },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
  { stopEarly: true },
);

const rows = await waitFor(join(dumps, 'smoke-resp', 'responses.jsonl'), 2);
const requests = await waitFor(join(dumps, 'smoke-resp', 'requests.jsonl'), 2);

check('two responses recorded', rows.length, 2);
check('seq follows its request', rows.map((row) => row.seq), [1, 2]);
check('stop is not interrupted', rows[1].interrupted, false);
check('blocks in stream order', rows[1].blocks.map((block) => block.type), ['reasoning', 'text', 'tool-call']);
check('assembled text', rows[1].blocks[1].text, '最新回复：已完成');
check('assembled tool arguments', rows[1].blocks[2].arguments, '{"path":"a.txt"}');
check('usage recorded', rows[0].usage, { inputTokens: 10, outputTokens: 3 });
check('each response names its request hash', rows.map((row) => row.request), requests.map((row) => row.sha1));

const abortRows = await waitFor(join(dumps, 'smoke-abort', 'responses.jsonl'), 1);
check('interrupted flagged', abortRows[0].interrupted, true);
check('interrupted keeps delivered text', abortRows[0].blocks.map((block) => block.text), ['截断的']);
check('interrupted has no finish', abortRows[0].reason, null);

if (failures.length === 0) rmSync(home, { recursive: true, force: true });
else console.error('kept ' + home);

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S)\n` + failures.join('\n'));
process.exitCode = failures.length === 0 ? 0 : 1;
