# Contributing to osnova

Thanks for contributing. This document covers the workflow, the gates your change must pass, and the invariants the codebase enforces.

## Setup

Requirements: Node.js >= 22.13.0 and pnpm (the exact version is pinned in `packageManager`).

```sh
pnpm install
```

After cloning, opt into the repo's git hooks once; they are not enabled by git automatically:

```sh
git config core.hooksPath .githooks
```

## Workflow

1. Branch from `main` (or `dev` if one is active) into a feature branch. `main` is protected: it accepts changes only through pull requests.
2. Keep PRs focused. One behavior or fix per PR.
3. Commit messages follow Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, ...). Subject in the imperative mood, no trailing period.
4. Open the PR against `main`. CI must be green on all three operating systems (Linux, macOS, Windows) before merge.

## Local gates

The repo ships git hooks that block broken code from being committed or pushed:

- `pre-commit`: lint and typecheck on staged changes.
- `pre-push`: lint, typecheck, and the full test suite. This is the client-side backstop; branch protection on `main` enforces the same checks server-side.

Run the full gate suite manually at any time:

```sh
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # tsup, ESM + dts
pnpm perf        # performance budgets on a generated fixture repo
```

`pnpm perf` is required when your change touches the engine, extraction, serialization, or anything on the hot path.

## Tests

- New adapters need golden tests in `test/extract.test.ts` or `test/adapters-extended.test.ts`, covering definitions, edges, and at least one cross-file resolution.
- Changes to `src/index/` must keep the incremental-equals-full property test green (`test/incremental.test.ts`). This invariant is byte-identical equality between an incrementally updated index and a full rebuild; it is the project's core correctness property.
- Query changes should update `test/query.test.ts`; MCP changes must keep the handshake and per-tool round-trips in `test/mcp.test.ts` passing.
- If you add a frozen-contract export or MCP tool shape, add a round-trip test for it in the same PR.

## Invariants (read before touching src/)

- **Determinism**: no timestamps, random values, or host-dependent ordering in index artifacts. All paths, symbols, and edges are sorted before serialization. `localeCompare` is banned in sort paths; use code-unit comparison.
- **Frozen contract**: the exported API (`buildIndex`, `loadIndex`, `applyChanges`, `freshness`, `ask`, `findText`, `skeleton`, `callers`, `map`, `renderMapCard`, `runMcpStdio`), the `cacheDir` parameter, `OSNOVA_CACHE_DIR`, and the MCP tool names and argument shapes are consumed downstream. Breaking them requires a coordinated major version.
- **Read-only**: no writes outside the cache directory, no network, no telemetry.
- **web-tree-sitter is pinned exactly** (0.25.10). The prebuilt grammars in `tree-sitter-wasms@0.1.13` use the older dynamic-linking format that 0.27 cannot load. Do not bump without probing every grammar (`test/grammar.test.ts`).
- **Edge semantics v1**: direct calls, imports, name references only. No type inference. Document precision limits in the README rather than working around them silently.

## Code style

- TypeScript ESM, strict tsconfig chain including `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`. Optional properties are declared `?: T | undefined`.
- No comments unless asked or matching surrounding style.
- One adapter per language under `src/extract/`, kept small; the TS adapter is shared by typescript, tsx, and javascript.
- `no-console` is enforced by eslint outside `scripts/`.

## Reporting issues

Open a GitHub issue with the command you ran, the full error, and the osnova version (`osnova --help` footer or `package.json`). For extraction bugs, include a minimal snippet of the source that extracts incorrectly.
