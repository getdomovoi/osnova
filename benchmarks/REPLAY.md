# Offline token and latency regression suite

For model-chosen behavior, use the separate [agent behavior suite](BEHAVIOR.md). Fixed replay cannot measure model adoption.

Run from the repository with existing dependencies. No model, network, paid calls or workload commands are involved.

```sh
pnpm run replay --samples 5 --output /tmp/osnova-baseline.json
pnpm run replay --samples 5 --baseline /tmp/osnova-baseline.json --output /tmp/osnova-candidate.json
```

Reports are created exclusively; use a new output name on each run. Exit 2 means a failed expectation, token budget, baseline comparison or invalid input. The report is saved even when a controlled replay fails. Unit tests include deliberate missing-answer, inflated-token and latency regressions so the checks are observed failing.

To avoid package-manager bootstrap or registry checks, invoke the same runner directly with existing dependencies: `node --import tsx scripts/bench/replay-cli.ts --samples 5 --output /tmp/osnova-baseline.json`.

## Controlled replay

`replay/core-v1.json` contains a disposable source fixture and a fixed sequence of 23 operations. The shell shapes come from local incident traces: task commands with output redirection and `tail`, status filtering, remote checks, external logs and filters with source-file operands. Project identifiers and source bodies have been replaced with independent synthetic examples. This is a regression fixture derived from observed behavior, not a replay of complete historical agent work.

The source cases check definitions, callers, tests, literal search and explicit clipping counts. Receipt cases cover an unchanged file after another file changes, revocation after the permitted file changes, and revocation at the next prompt. Shell commands are passed to the gate as data and never executed. Edits affect only the inline fixture in a temporary directory. Existing projects and caches are not used.

Each query has required and forbidden answer anchors plus a token ceiling. Anchors are independent expectations written against the fixture; a smaller output that loses one fails. These checks prove only the named facts, not arbitrary semantic equivalence or task success. Tighten or add anchors before relying on a new scenario. The checked-in token ceilings allow approximately 10% headroom over the initial fixture measurements.

The runner uses the existing `cl100k_base` estimator. Generation receipts and temporary paths are normalized before token counting and hashing, keeping repeated runs comparable. Counts cover delivered query text, denial reasons and permitted read excerpts. They omit prompts, tool schemas, model reasoning, tool-call wrappers and provider cache accounting. Duplicate response tokens count identical delivered text, including repeated denial reasons; they do not prove that a call was unnecessary. These are estimates, not billing or predicted agent savings.

Each sample starts with a fresh fixture/cache. One fresh worker hosts all samples, so grammar initialization and JIT may warm between samples. Timings cover in-memory MCP and in-process hook execution; they exclude client scheduling and per-hook process startup. `elapsedMs` for a query includes successful-result recording; `markMs` is the recording subset and must not be added again. Small sample p95 values are coarse regression signals, not production tail-latency claims.

Baseline comparison requires the same manifest and harness fingerprints, tokenizer, Node version, platform, architecture and CPU model, and at least three samples in both reports. It rejects any per-step token increase and p95 latency above `baseline * 1.25 + 10 ms`. Override the timing tolerances with `--latency-ratio` and `--latency-slack-ms` when justified. Compare on the same machine under similar load. Implementation fingerprints include source, benchmark code, package metadata and the dependency lockfile; the CLI refuses a run if those change during execution.

## Private historical trace audit

```sh
pnpm run replay --trace /absolute/private/session.jsonl \
  --since 2026-09-24T00:00:00Z --output /tmp/osnova-trace-audit.json
```

The separate audit reads Claude-style `message.content` JSONL, correlates `tool_use` and `tool_result` IDs, and counts observed calls, repeated identical call arguments, errors, Osnova denial messages, response tokens and identical response tokens. Duplicate transcript records with the same call/result ID are counted once. `--since` filters by record timestamp; results whose initiating call falls outside the window are counted as unmatched. Other transcript schemas are not supported. Malformed JSON is counted and causes exit 2; a partial final record in an active trace may trigger this.

The stream is bounded to the initial file size (maximum 256 MiB); later appends are excluded. A source fingerprint and byte count identify the audited prefix. Output is aggregate-only: it contains no project paths, raw session IDs, commands, prompts or response bodies. Keep reports from private traces outside the public repository. Source-reported token billing and model task outcomes are deliberately unmeasured. Observed tool latency includes host scheduling and cannot be compared directly with controlled replay timings.
