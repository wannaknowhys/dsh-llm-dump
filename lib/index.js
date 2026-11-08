// dsh-llm-dump — capture every complete LLM request, folded by message prefix.
//
// Hook: the `llm/stream` waterfall carries the exact `GenerateOptions` handed to
// the provider adapter (assembled system prompt, full message array, active tool
// definitions, sampling). The listener observes and never modifies it.
//
// Storage (per session, append-only):
//   <outputDir>/<session>/objects.jsonl   unique content: {"h":sha1,"v":value}
//   <outputDir>/<session>/requests.jsonl  {"prefixLen":n,"suffix":[hash...],...}
//   <outputDir>/<session>/responses.jsonl {"seq":n,"blocks":[...],...}
// A request reuses the previous request's first `prefixLen` messages; only the
// suffix after that point is listed. Replay in order to rebuild any request.
//
// The response file is what keeps the dump's tail complete: the reply to the
// newest request only enters a *later* request, so without it the newest answer
// is invisible until the next turn starts.
//
// Config (re-read on change):
//   %DSH_HOME%\llm-dumps\config.json
//   { "outputDir": "..." }

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const CONFIG_PATH =
  process.env.DSH_LLM_DUMP_CONFIG || join(DSH_HOME, 'llm-dumps', 'config.json');

const DEFAULT_CONFIG = {
  outputDir: join(DSH_HOME, 'llm-dumps'),
};

let cached = { mtime: -1, config: DEFAULT_CONFIG };

function loadConfig() {
  try {
    const mtime = existsSync(CONFIG_PATH) ? statSync(CONFIG_PATH).mtimeMs : -1;
    if (mtime === cached.mtime) return cached.config;
    const parsed = mtime === -1 ? {} : JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    cached = { mtime, config: { ...DEFAULT_CONFIG, ...(parsed || {}) } };
  } catch {
    cached = { mtime: -1, config: DEFAULT_CONFIG };
  }
  return cached.config;
}

function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Stable JSON: sorted keys, so equal content always hashes equally. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key]));
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(value);
}

/** JSON-safe copy: functions/symbols dropped, bytes marked, cycles broken. */
function plain(value) {
  const seen = new WeakSet();
  return JSON.parse(
    JSON.stringify(value, function (_key, item) {
      if (typeof item === 'function' || typeof item === 'symbol') return undefined;
      if (typeof item === 'bigint') return item.toString();
      if (item instanceof Uint8Array) return { $bytes: item.byteLength };
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }) ?? 'null',
  );
}

/**
 * Assemble the assistant message a chunk stream describes, under the same rules
 * the harness's own BlockAssembler applies: deltas accumulate per block index, a
 * `block-end` overrides the accumulated form, `max-tokens` drops tool calls (they
 * cannot be executed), and an interrupted stream keeps only closed text/reasoning.
 * Duplicated here because a plugin cannot import the harness's internal package.
 */
class AssistantAssembly {
  constructor() {
    this.partials = new Map();
    this.order = [];
    this.usage = undefined;
    this.reason = null;
  }

  ensure(index, blockType) {
    let partial = this.partials.get(index);
    if (partial === undefined) {
      partial = { blockType, text: '', args: '', id: undefined, name: undefined, block: undefined };
      this.partials.set(index, partial);
      this.order.push(index);
    }
    return partial;
  }

  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return;
    switch (chunk.type) {
      case 'block-start':
        this.ensure(chunk.index, chunk.blockType);
        return;
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning');
        if (partial.block === undefined && typeof chunk.text === 'string') partial.text += chunk.text;
        return;
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call');
        if (partial.block !== undefined) return;
        if (typeof chunk.id === 'string') partial.id = chunk.id;
        if (chunk.name) partial.name = chunk.name;
        if (typeof chunk.argumentsDelta === 'string') partial.args += chunk.argumentsDelta;
        return;
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block?.type ?? 'text');
        if (partial.block === undefined && chunk.block) partial.block = chunk.block;
        return;
      }
      case 'usage':
        this.usage = chunk.usage;
        return;
      case 'finish':
        this.reason = chunk.reason ?? null;
        return;
      default:
        return;
    }
  }

  assemble(partial, index) {
    if (partial.block !== undefined) return partial.block;
    if (partial.blockType === 'text') return { type: 'text', text: partial.text };
    if (partial.blockType === 'reasoning') return { type: 'reasoning', text: partial.text };
    if (partial.blockType === 'tool-call') {
      return {
        type: 'tool-call',
        id: partial.id ?? `call-${index}`,
        name: partial.name ?? '',
        arguments: partial.args,
      };
    }
    return null;
  }

  /** The durable record body: mode-correct blocks plus what the stream reported. */
  snapshot() {
    const kind = this.reason?.kind;
    const interrupted = kind === undefined || kind === 'error' || kind === 'aborted';
    let blocks = this.order
      .map((index) => this.assemble(this.partials.get(index), index))
      .filter(Boolean);
    if (interrupted) {
      blocks = blocks.filter(
        (block) => (block.type === 'text' || block.type === 'reasoning') && block.text.trim() !== '',
      );
    } else if (kind === 'max-tokens') {
      blocks = blocks.filter((block) => block.type !== 'tool-call');
    }
    return { reason: this.reason, usage: this.usage, blocks, interrupted };
  }
}

function safeId(sessionId) {
  const raw = String(sessionId ?? 'global');
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'global';
}

class SessionStore {
  constructor(directory) {
    this.directory = directory;
    this.objects = new Map(); // hash -> value
    this.messageHashes = []; // last request's ordered message hashes
    this.seq = 0;
    this.loaded = false;
    this.loading = null;
    this.queue = Promise.resolve();
    this.objectHashes = new WeakMap(); // frozen message object -> hash
  }

  async ensureLoaded() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      await mkdir(this.directory, { recursive: true });
      const objectsPath = join(this.directory, 'objects.jsonl');
      if (existsSync(objectsPath)) {
        for (const line of (await readFile(objectsPath, 'utf8')).split('\n')) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            if (typeof row.h === 'string') this.objects.set(row.h, row.v);
          } catch {
            /* one corrupt line must not poison the store */
          }
        }
      }
      const requestsPath = join(this.directory, 'requests.jsonl');
      let previous = [];
      let seq = 0;
      if (existsSync(requestsPath)) {
        for (const line of (await readFile(requestsPath, 'utf8')).split('\n')) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            previous = previous.slice(0, row.prefixLen).concat(row.suffix);
            seq = row.seq ?? seq;
          } catch {
            /* ignore */
          }
        }
      }
      this.messageHashes = previous;
      this.seq = seq;
      this.loaded = true;
      this.loading = null;
    })();
    return this.loading;
  }

  hashOf(value) {
    if (value && typeof value === 'object') {
      const cachedHash = this.objectHashes.get(value);
      if (cachedHash !== undefined) return cachedHash;
      const hash = sha1(canonical(value));
      this.objectHashes.set(value, hash);
      return hash;
    }
    return sha1(canonical(value));
  }

  append(options) {
    const run = async () => {
      await this.ensureLoaded();
      const config = loadConfig();
      const clean = plain(options);
      const messages = Array.isArray(clean.messages) ? clean.messages : [];
      const tools = clean.tools ?? null;

      const newObjects = [];
      // Small fields stay inline so the record reads well; large ones (a tool
      // history, a big stop list, ...) become content-addressed references.
      const top = {};
      for (const [key, value] of Object.entries(clean)) {
        if (key === 'messages' || key === 'tools') continue;
        const size = JSON.stringify(value)?.length ?? 0;
        if (size > 1024) {
          const hash = this.hashOf(value);
          if (!this.objects.has(hash)) {
            newObjects.push({ h: hash, v: value });
            this.objects.set(hash, value);
          }
          top[key] = { $dshRef: hash };
        } else {
          top[key] = value;
        }
      }

      const messageHashes = messages.map((message) => this.hashOf(message));
      let prefixLen = 0;
      const limit = Math.min(this.messageHashes.length, messageHashes.length);
      while (prefixLen < limit && this.messageHashes[prefixLen] === messageHashes[prefixLen]) {
        prefixLen += 1;
      }
      const suffix = messageHashes.slice(prefixLen);

      const toolsHash = tools === null ? null : this.hashOf(tools);
      messages.forEach((message, index) => {
        const hash = messageHashes[index];
        if (!this.objects.has(hash)) {
          newObjects.push({ h: hash, v: message });
          this.objects.set(hash, message);
        }
      });
      if (toolsHash !== null && !this.objects.has(toolsHash)) {
        newObjects.push({ h: toolsHash, v: tools });
        this.objects.set(toolsHash, tools);
      }

      const record = {
        at: new Date().toISOString(),
        seq: ++this.seq,
        sessionId: clean.sessionId === undefined ? null : String(clean.sessionId),
        provider: clean.provider ?? null,
        model: clean.model ?? null,
        messageCount: messages.length,
        toolCount: Array.isArray(tools) ? tools.length : 0,
        prefixLen,
        suffix,
        tools: toolsHash,
        top,
        sha1: sha1(canonical(clean)),
      };

      if (newObjects.length > 0) {
        await appendFile(
          join(this.directory, 'objects.jsonl'),
          newObjects.map((row) => JSON.stringify(row) + '\n').join(''),
          'utf8',
        );
      }
      await appendFile(join(this.directory, 'requests.jsonl'), JSON.stringify(record) + '\n', 'utf8');
      this.messageHashes = messageHashes;
      return record;
    };

    // The internal chain never rejects (one failed write must not stall the
    // queue); the caller gets the real result so a response can name its seq.
    const result = this.queue.then(run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Append one response record, after every request write already queued. */
  appendResponse(row) {
    const run = async () => {
      await this.ensureLoaded();
      await appendFile(join(this.directory, 'responses.jsonl'), JSON.stringify(row) + '\n', 'utf8');
    };
    this.queue = this.queue.then(run).catch(() => {});
    return this.queue;
  }
}

export const name = 'llm-dump';
export const inject = ['llm'];

export function apply(ctx) {
  const stores = new Map();
  let warned = false;

  function warn(error) {
    if (warned) return;
    warned = true;
    try {
      ctx.logger?.warn?.(`llm-dump: ${error?.message ?? String(error)}`);
    } catch {
      /* never break the request path */
    }
  }

  ctx.on('llm/stream', function dumpRequest(options, next) {
    let capture = null;
    try {
      const config = loadConfig();
      const key = safeId(options?.sessionId);
      const store = stores.get(key) ?? new SessionStore(join(config.outputDir, key));
      stores.set(key, store);
      // A rejected append must not surface as an unhandled rejection just
      // because nobody watched it; the response simply carries no seq.
      const appended = store.append(options).then(
        (record) => record,
        () => null,
      );
      capture = { store, appended };
    } catch (error) {
      warn(error);
    }

    const stream = next();
    return capture === null ? stream : tapResponse(stream, capture.store, capture.appended);
  });
}

/** Forward every chunk unchanged while one assembler observes the same stream. */
function tapResponse(stream, store, appended) {
  const assembly = new AssistantAssembly();
  const startedAt = Date.now();
  return (async function* forward() {
    const iterator = stream[Symbol.asyncIterator]();
    let finished = false;
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done) {
          finished = true;
          break;
        }
        try {
          assembly.push(step.value);
        } catch {
          /* observation never breaks the response stream */
        }
        yield step.value;
      }
    } finally {
      // A consumer that stopped early leaves the adapter stream open; close it
      // before recording so the record reflects exactly what was delivered.
      if (!finished) {
        try {
          await iterator.return?.();
        } catch {
          /* best-effort upstream close */
        }
      }
      void recordResponse(store, assembly, appended, Date.now() - startedAt).catch(() => {});
    }
  })();
}

async function recordResponse(store, assembly, appended, ms) {
  const request = await appended;
  if (!request || !Number.isInteger(request.seq)) return;
  await store.appendResponse({
    seq: request.seq,
    request: request.sha1,
    at: new Date().toISOString(),
    ms,
    ...assembly.snapshot(),
  });
}

export { SessionStore, AssistantAssembly, canonical, plain };
