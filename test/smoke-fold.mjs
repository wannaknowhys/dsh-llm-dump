// Offline test for the folded store: prefix reuse, content-addressed large
// fields, and the canonical hash of every replayed request.
//
//   node test/smoke-fold.mjs
//
// Runs in a throwaway DSH_HOME; the real profile is never touched.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-fold-'));
process.env.DSH_HOME = home;
const dumps = join(home, 'dumps');
mkdirSync(join(home, 'llm-dumps'), { recursive: true });
writeFileSync(join(home, 'llm-dumps', 'config.json'), JSON.stringify({ outputDir: dumps }));

const { apply, canonical, plain } = await import('../lib/index.js');

const failures = [];
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : ` (${JSON.stringify(actual)})`}`);
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
check('advertises the data format version', pkg.dsh?.formatVersion, 1);

const sha1 = (text) => createHash('sha1').update(text, 'utf8').digest('hex');

async function waitFor(path, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim());
      if (lines.length >= count) return lines.map((line) => JSON.parse(line));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
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

const system = { role: 'system', content: [{ type: 'text', text: 'You are a test system prompt.' }] };
const user1 = { role: 'user', content: [{ type: 'text', text: '第一轮问题 中文' }] };
const assistant1 = { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] };
const user2 = { role: 'user', content: [{ type: 'text', text: 'second question' }] };
const user3 = { role: 'user', content: [{ type: 'text', text: 'third question' }] };

const tools = [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }];
// A large top-level field must become one shared reference, not be copied into
// every request record.
const toolHistory = Array.from({ length: 300 }, (_, index) => ({
  name: 'tool' + index,
  description: 'x'.repeat(80),
}));

const base = {
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  temperature: 1,
  maxTokens: 256000,
  reasoningEffort: 'max',
  tools,
  toolHistory,
};
const sessionId = 'smoke-fold';
const optionsFor = (messages) => ({ ...base, sessionId, messages });
const noStream = () =>
  (async function* () {
    /* the capture test never consumes a stream */
  })();

const requests = [
  [system, user1, assistant1, user2],
  [system, user1, assistant1, user2, user3],
  [system, user1, assistant1, user2, user3], // identical retry
];
for (const messages of requests) hook(optionsFor(messages), noStream);

const dir = join(dumps, sessionId);
const rows = await waitFor(join(dir, 'requests.jsonl'), requests.length);

check('one record per request', rows.length, 3);
check('message counts', rows.map((row) => row.messageCount), [4, 5, 5]);
check('prefix reuse', rows.map((row) => row.prefixLen), [0, 4, 5]);
check('only the new suffix is listed', rows.map((row) => row.suffix.length), [4, 1, 0]);
check(
  'no response is written when the stream is never consumed',
  existsSync(join(dir, 'responses.jsonl')),
  false,
);

const objects = new Map(
  readFileSync(join(dir, 'objects.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .map((row) => [row.h, row.v]),
);
check('objects are content-addressed and unique', objects.size, 7);
check('toolHistory is stored once', [...objects.values()].filter((value) => Array.isArray(value) && value.length === 300).length, 1);
check('toolHistory is referenced from the record', typeof rows[0].top.toolHistory?.$dshRef, 'string');

const replayed = [];
let messages = [];
rows.forEach((row, index) => {
  const suffix = row.suffix.map((hash) => {
    if (!objects.has(hash)) throw new Error('missing object ' + hash);
    return objects.get(hash);
  });
  messages = messages.slice(0, row.prefixLen).concat(suffix);
  const top = {};
  for (const [key, value] of Object.entries(row.top)) {
    top[key] = value && typeof value === 'object' && typeof value.$dshRef === 'string' ? objects.get(value.$dshRef) : value;
  }
  const request = { ...top, messages, ...(row.tools === null ? {} : { tools: objects.get(row.tools) }) };
  replayed.push(request);
  check(`#${index + 1} replays to the captured request`, sha1(canonical(plain(request))), row.sha1);
});
check('replayed message counts', replayed.map((request) => request.messages.length), [4, 5, 5]);
check('replayed messages keep their content', replayed[1].messages, [system, user1, assistant1, user2, user3]);

if (failures.length === 0) rmSync(home, { recursive: true, force: true });
else console.error('kept ' + home);

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURE(S)\n` + failures.join('\n'));
process.exitCode = failures.length === 0 ? 0 : 1;
