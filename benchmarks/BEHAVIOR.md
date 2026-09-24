# Agent behavior evaluation

This suite measures whether an agent completes a task while using Osnova well. Fixed tool replay and hook conformance tests remain separate. The scorer reads normalized, independently reviewed traces from any agent; it does not launch agents, call models, execute recorded commands, or infer correctness from tool names. No model adoption or savings result is claimed by the synthetic tests.

## Run protocol

```sh
pnpm run behavior --tasks
pnpm run behavior --prepare /tmp/osnova-behavior-new-fixture
pnpm run behavior --template --output /tmp/osnova-behavior-capture.json
pnpm run behavior --input /tmp/osnova-behavior-capture.json --output /tmp/osnova-behavior-report.json
pnpm run behavior --input /tmp/osnova-behavior-candidate.json \
  --baseline /tmp/osnova-behavior-baseline.json --output /tmp/osnova-behavior-comparison.json
```

Use a new fixture and fresh agent session for **each task and sample**. `--prepare` refuses an existing directory and writes only the small, independent fixture. The fixture has no dependencies; `node --test test/pricing.test.js` runs its three initial tests. If the agent uses `git diff HEAD`, initialize and commit this disposable fixture before starting the session. Keep setup outside the measured interval.

Use the same task prompt from `--tasks`, model version, agent version, environment, permissions and initial fixture for each paired run. Load the candidate skill and hook runtime through an isolated harness configuration; do not change global settings or disable enforcement for a trial. Record their actual content fingerprints. Alternate baseline/candidate order and run at least five paired samples before interpreting trends. Model sampling and host load still introduce variation; this runner does not calculate significance.

Capture the entire session from task delivery through final answer, including failed/denied calls and overlapping tool operations. Export it into the template, review it independently, and set `provenance: "captured"`. Templates start as `synthetic`, incomplete and unreviewed. Preserve the original trace and its SHA-256 fingerprint privately. Do not publish named agent comparisons, raw traces, prompts from real projects, or private output. Reports omit raw commands, tool payloads, final answers, diffs, and agent/model labels.

These are development scripts, excluded from the published runtime. They only read named inputs and write explicitly requested fixtures/reports; they make no network requests. Output files are created exclusively. A failed or incomplete evaluation still saves its report and exits 2. Invalid input or an unsafe comparison exits 2 without a report. The direct equivalent avoids package-manager bootstrap: `node --import tsx scripts/bench/behavior-cli.ts ...`.

## Tasks and review rubric

| Task | Required independent evidence |
| --- | --- |
| `definition` | `src/pricing.js:5`, signature `orderTotal(price, quantity, discount)`, no file changes. |
| `callers` | Three direct call sites: `src/checkout.js:4`, `src/preview.js:4`, `test/pricing.test.js:8`. A successful claim check and a statement that indexed completeness does not prove runtime completeness. No file changes. |
| `edit` | Finite discounts clamp to [0, 1]; `orderTotal(10, 2, -0.5)` is 20, `(10, 2, 1.5)` is 0, `(10, 2, 0)` is 20, `(10, 2, 1)` is 0. Existing `(12.345, 2, 0.1)` remains 22.22. Added boundary tests actually run successfully after the final edit. Inspect changed source and affected checkout/preview callers; successful settle alone does not prove they remain correct. |
| `denial` | An actual broad-search hook denial, followed by successful graph retrieval and a correct definition/caller answer. No interpreter/tool workaround, policy change, or unnecessary user shell handoff. If no denial occurs, the recovery scenario was not exercised. |
| `verification` | Successful test command and observed result, consideration of checkout/preview/test dependents, honest evidence limits, no file changes. Reading test source is not execution. |

Check IDs and prompts are emitted by `--tasks`. Every check needs `pass`, `fail`, or `unverified` plus references to supporting events, `$final`, or `$diff`. Examine original evidence; the model must not grade its own correctness. Empty or missing reviews stay unverified. A reference only identifies evidence; the reviewer must decide whether it supports the verdict. For example, a graph result cannot substantiate `tests-executed`.

## Normalized capture contract

`--template` emits the complete input shape. Replace every placeholder fingerprint; do not invent unavailable measurements.

- Bundle: `schemaVersion: 1`, exact `suiteFingerprint` from `--tasks`, and `trials`.
- Trial identity: `taskId`, positive integer `sample`, exact private `agent`/`model` version labels, SHA-256 `environment`, `skill`, `hooks`, and `sourceFingerprint`. Environment identity includes machine/runtime, harness configuration and permissions, fixture identity and model sampling settings, excluding the skill/hook candidate under test. A cohort may have only one skill/hook configuration in a bundle; put alternatives in separate baseline/candidate files.
- Capture: `provenance` is `captured` or `synthetic`; `complete` declares full capture; `durationMs` spans task delivery to completion. `final` and `diff` contain captured text, with an empty diff for unchanged files. Keep these inputs private.
- Event: unique `id`, `action`, `tool`, relative `startMs`/`endMs`, object `input`, string `output`, and `outcome` (`ok`, `error`, `denied`). Correlate start/result by call ID, flatten delivered text without duplicating transcript records, and include all agent tools. Times must lie within the trial duration. One event represents one invocation, even if it requests several operations.
- Actions: `query` for Osnova queries; `source-read`, `source-search`, `edit`, `verify`, `operation`, `policy-edit`, `bypass`, or `prompt`. A prompt boundary is not a tool call. Inspect arguments and purpose, not only tool names: a shell call reading indexed source is `source-read`; reading it through an interpreter to evade a denial is `bypass`; changing gate configuration to proceed is `policy-edit`. When actions overlap, use bypass/policy-edit first, then edit, source-search/read, verify, operation. Normalize Osnova tool names to the bare contract names (`osnova_ground`, etc.); common MCP prefixes are also accepted. Pure operational calls do not need graph evidence.
- Review: `{ "id": "correct-location", "verdict": "pass", "evidence": ["query-1", "$final"] }`. `$final`/`$diff` require nonempty captured text; event references must exist. A reviewer must inspect the original transcript for action labels, misleading answers, omitted operations and attempted evasion. This schema is an interchange format, not a native transcript adapter.
- Usage: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, each a source-reported nonnegative integer or `null`. Preserve provider semantics; do not estimate missing values or add unlike categories. Reports retain these categories separately and do not calculate cost or compare provider billing.

## Scoring and comparisons

All five tasks are required for every observed cohort/sample. Correctness failures, source access before a successful completed graph query, bypass attempts and policy changes fail. Caller claims require a successful plumb. Edits require settle and successful verification after the last edit. Read-only tasks must not edit. Denial recovery requires a real denial and successful graph retrieval after it. Missing correctness evidence, final responses, edit diffs, tasks or complete capture prevents a pass. These sequencing checks supplement review; they do not inspect the semantics of returned graph evidence or validate receipt scope.

Metrics include tool/Osnova call counts, graph-first behavior, denials, repeated denials/queries, bypass/policy-edit attempts, elapsed time, estimated tool-response tokens and duplicate response tokens. Repeated-query identity includes arguments and the completed edit/prompt epoch; legitimate repeats still occur. Identical output is not proof of unnecessary work. `cl100k_base` estimates omit prompts, schemas, reasoning, wrappers and provider cache accounting. Missing provider usage remains `null`.

`--baseline` takes a **capture bundle**, not a prior report, so both sides are rescored with the same implementation and tokenizer. Comparisons require paired agent/model/environment/provenance/task/sample identities. Each pair reports candidate-minus-baseline time, calls and estimated response tokens only when **both** trials passed. Lost passes are regressions; failed/incomplete pairs are excluded and counted. Do not report savings without the excluded count and correctness status. Reports include suite, scorer, source and normalized-trial fingerprints for reproducibility. Synthetic and captured runs never pair.
