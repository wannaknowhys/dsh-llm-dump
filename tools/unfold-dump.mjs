// Rebuild and verify captured LLM requests from the folded dump.
//
//   node unfold-dump.mjs <sessionId>                 # last request, pretty JSON
//   node unfold-dump.mjs <sessionId> --seq 3         # one request
//   node unfold-dump.mjs <sessionId> --verify        # integrity check of every row
//   node unfold-dump.mjs <sessionId> --summary       # one line per request
//   node unfold-dump.mjs <sessionId> --out req.json  # write instead of print
//
// Exit code 1 on a verification failure.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const CONFIG_PATH = process.env.DSH_LLM_DUMP_CONFIG || join(DSH_HOME, 'llm-dumps', 'config.json');

function config() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (!sessionId) {
  console.error('usage: unfold-dump.mjs <sessionId> [--seq N] [--verify] [--summary] [--out FILE]');
  process.exit(2);
}
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1] ?? true;
};

const outputDir = config().outputDir || join(DSH_HOME, 'llm-dumps');
const dir = join(outputDir, sessionId);
if (!existsSync(join(dir, 'requests.jsonl'))) {
  console.error('no dump for session ' + sessionId + ' under ' + dir);
  process.exit(2);
}

const objects = new Map();
for (const line of readFileSync(join(dir, 'objects.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  objects.set(row.h, row.v);
}

const rows = readFileSync(join(dir, 'requests.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const verify = args.includes('--verify');
const summary = args.includes('--summary');
const wantedSeq = flag('--seq');

let messages = [];
let failures = 0;
let rebuilt = null;
let rebuiltRow = null;

/** Resolve content-addressed fields written as { $dshRef: hash }. */
function expandTop(top) {
  const out = {};
  for (const [key, value] of Object.entries(top ?? {})) {
    if (value && typeof value === 'object' && typeof value.$dshRef === 'string') {
      if (!objects.has(value.$dshRef)) throw new Error('missing object ' + value.$dshRef);
      out[key] = objects.get(value.$dshRef);
    } else {
      out[key] = value;
    }
  }
  return out;
}

for (const row of rows) {
  const prefix = messages.slice(0, row.prefixLen);
  const suffix = row.suffix.map((hash) => {
    if (!objects.has(hash)) throw new Error('missing object ' + hash);
    return objects.get(hash);
  });
  messages = prefix.concat(suffix);
  const tools = row.tools === null ? undefined : objects.get(row.tools);
  const request = { ...expandTop(row.top), messages, ...(tools === undefined ? {} : { tools }) };

  let ok = null;
  if (verify) {
    ok = sha1(canonical(request)) === row.sha1;
    if (!ok) failures += 1;
  }
  if (summary) {
    console.log(
      `#${String(row.seq).padStart(3)} ${row.at} msgs=${row.messageCount} prefix=${row.prefixLen} new=${row.suffix.length} tools=${row.toolCount}${ok === null ? '' : ok ? ' ok' : ' MISMATCH'}`,
    );
  }
  if (wantedSeq === undefined || String(row.seq) === String(wantedSeq)) {
    rebuilt = request;
    rebuiltRow = row;
  }
}

if (verify && !summary) {
  console.log(`verified ${rows.length} request(s): ${failures === 0 ? 'all match' : failures + ' MISMATCH'}`);
  process.exit(failures === 0 ? 0 : 1);
}

if (summary) process.exit(0);

if (rebuilt === null) {
  console.error('request not found');
  process.exit(2);
}

const text = JSON.stringify(rebuilt, null, 2);
const out = flag('--out');
if (typeof out === 'string') {
  writeFileSync(out, text, 'utf8');
  console.error(`wrote ${out} (${rebuiltRow.messageCount} messages, seq ${rebuiltRow.seq})`);
} else {
  console.log(text);
}
