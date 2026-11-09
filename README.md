[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-llm-dump

Captures **every complete LLM request** and stores it folded: repeated message
prefixes and large repeated fields are stored once and referenced by hash.

- Hook: the `llm/stream` waterfall. The listener observes `GenerateOptions` and
  never modifies it, so capture cannot change what the model receives.
- No `fetch` interception is involved: the full request object is available at
  this seam, so prefix matching is a local computation over captured payloads.

This is a host-side bundle with no browser half. It needs a DeepSeek Harness
build that provides the `llm` service.

## Install / remove

```sh
# from npm
dsh plugin --profile desktop add dsh-llm-dump

# from a checkout
dsh plugin --profile desktop add github:wannaknowhys/dsh-llm-dump

# remove
dsh plugin --profile desktop remove dsh-llm-dump
```

The plugin manager accepts the same specs: `install_bundle target = dsh-llm-dump`
or the checkout directory.

Host modules do not hot-reload. After editing one, toggle its bundle so the Host
re-imports the module.

## What is captured

`GenerateOptions` at the provider boundary:

- `messages` — the full model-visible conversation, including the assembled
  system prompt
- `tools` — active tool definitions
- `model`, `provider`, `sessionId`, sampling fields
- `toolHistory` and other large top-level fields (stored once, referenced)

Adapters may still transform the request afterwards (image projection, tool
updates, deferred loading); this is the last public state before that step.

## Storage

```
<outputDir>/<sessionId>/
  objects.jsonl    {"h": sha1, "v": <content>}   unique content, written once
  requests.jsonl   {"prefixLen": n, "suffix": [hash...], ...}
  responses.jsonl  {"seq": n, "blocks": [...], ...}   the answer to request n
```

A request reuses the first `prefixLen` messages of the previous request in the
same session and lists only the new suffix. An identical retry becomes a record
with `prefixLen == messageCount` and an empty suffix. A compaction or rewrite
shows up as a shorter `prefixLen` plus a larger suffix — nothing is lost.

Each record also carries `sha1`, the hash of the whole request's canonical JSON,
so a replay can prove it reconstructed the exact content.

## Data format (version 1)

`requests.jsonl` and `responses.jsonl` are an append-only contract shared with
[dsh-dump-manager](https://github.com/wannaknowhys/dsh-dump-manager). Readers
must ignore unknown fields so a later minor version can add them.

The format number is advertised as `dsh.formatVersion` in this package's
`package.json` (currently `1`), independently of the package's semver — a
UI-only release does not look like a format change. `dsh-dump-manager` reads it
at startup and warns when it cannot read what this writer produces.

| File | One line per | Fields |
| --- | --- | --- |
| `objects.jsonl` | unique content | `h` (SHA-1 of canonical JSON), `v` (the value) |
| `requests.jsonl` | request | `at`, `seq`, `sessionId`, `provider`, `model`, `messageCount`, `toolCount`, `prefixLen`, `suffix`, `tools`, `top`, `sha1` |
| `responses.jsonl` | finished stream | `seq`, `request` (the request `sha1`), `at`, `ms`, `reason`, `usage`, `blocks`, `interrupted` |

- `messages` is stored only through `suffix`; `prefixLen` says how much of the
  previous request's message list is reused.
- `top` holds every other top-level field. A value larger than 1 KB is replaced
  by `{"$dshRef": "<hash>"}` and stored once in `objects.jsonl`; `tools` uses the
  same indirection (or `null` when the request had no tools).
- Hashes are SHA-1 over canonical JSON (sorted keys, no whitespace), the same
  computation `tools/unfold-dump.mjs --verify` repeats.

## Response capture

Requests alone cannot show the newest answer: the reply to request *n* only
enters the dump when request *n+1* resends it as an `assistant` message. The
listener therefore also reads the stream it is forwarding and appends one line to
`responses.jsonl` when the stream ends:

```json
{"seq": 12, "request": "<sha1>", "at": "…", "ms": 3412,
 "reason": {"kind": "stop"}, "usage": {...},
 "blocks": [{"type": "text", "text": "…"}], "interrupted": false}
```

- Blocks are assembled with the harness's own rules, duplicated here because a
  plugin cannot import the internal package: deltas per index, `block-end`
  overrides, `max-tokens` drops tool calls, an interrupted stream keeps only
  closed text/reasoning.
- `interrupted` is true when no `finish` chunk arrived (consumer cancelled) or
  the finish kind is `error` / `aborted`; the record then holds exactly what was
  delivered before the cut.
- Capture is observation only: every chunk is forwarded unchanged, the upstream
  iterator is closed when a consumer stops early, and no error can escape into
  the response path.

Every response is stored, but they are mostly redundant — all except the newest
one reappear inside the next request. `dsh-dump-manager` shows only the newest,
which is the one the request snapshots can never contain.

## Config

`%DSH_HOME%\llm-dumps\config.json` — re-read when its mtime changes:

```json
{
  "outputDir": "D:/llm-dumps"
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `outputDir` | `%DSH_HOME%\llm-dumps` | Where session directories are written |

`DSH_LLM_DUMP_CONFIG` overrides the config path.

`dsh-dump-manager` can edit this file from its settings page; unknown keys are
preserved and the write is atomic.

## Replay

```powershell
node tools/unfold-dump.mjs <sessionId> --summary
node tools/unfold-dump.mjs <sessionId> --verify
node tools/unfold-dump.mjs <sessionId> --seq 3 --out req.json
```

`--verify` recomputes the canonical hash of every replayed request and fails on
any mismatch. The tool reads `outputDir` from the same config file, so it works
against any capture directory.

## Tests

```powershell
npm test
```

Both tests run in a throwaway `DSH_HOME` under the system temp directory and
never touch the real profile:

- `test/smoke-fold.mjs` — prefix reuse, one object per unique value, and a replay
  whose canonical hash matches every record.
- `test/smoke-response.mjs` — chunk forwarding, block assembly, the `seq` /
  `sha1` link back to the request, and an aborted stream.

## Privacy

The dump holds the entire model-visible conversation, including file contents,
tool output, and the system prompt. Keep it out of repositories and delete it
when the investigation ends.
