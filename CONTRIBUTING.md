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

- `pre-commit`: lint and typecheck against an exported staged snapshot, not unrelated working-tree edits.
- `pre-push`: lint, typecheck, build, and the full test suite against each pushed tree. The snapshot runner never installs/reconciles dependencies. This is the client-side backstop; branch protection on `main` enforces the same checks server-side.

Run the full gate suite manually at any time:

```sh
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # tsup, ESM + dts
pnpm perf        # performance budgets on a generated fixture repo
pnpm check:package # packaged target validation
pnpm test:package  # packed consumer with existing dependencies
pnpm test:install  # fresh registry-backed package install and consumer
```

`pnpm perf` is required when your change touches the engine, extraction, serialization, or anything on the hot path.

## Tests

- New adapters need golden tests in `test/extract.test.ts` or `test/adapters-extended.test.ts`, covering definitions, edges, and at least one cross-file resolution.
- Changes to `src/index/` must keep the incremental-equals-full property test green (`test/incremental.test.ts`). This invariant is byte-identical equality between an incrementally updated index and a full rebuild; it is the project's core correctness property.
- Query changes should update `test/query.test.ts`; MCP changes must keep the handshake and per-tool round-trips in `test/mcp.test.ts` passing.
- If you add a frozen-contract export or MCP tool shape, add a round-trip test for it in the same PR.

## Invariants (read before touching src/)

- **Determinism**: no timestamps, random values, or host-dependent ordering in index artifacts. All paths, symbols, and edges are sorted before serialization. `localeCompare` is banned in sort paths; use code-unit comparison.
- **Frozen contract**: existing exported APIs, the `cacheDir` parameter, `OSNOVA_CACHE_DIR`, and every MCP tool name and argument shape registered in `src/mcp/server.ts` (the list in `AGENTS.md`) are consumed downstream. Breaking them requires a coordinated major version. Additive APIs require direct and package round-trip tests.
- **Read-only**: no writes outside the cache directory, no network, no telemetry.
- **web-tree-sitter is pinned exactly** (0.25.10). The prebuilt grammars in `tree-sitter-wasms@0.1.13` use the older dynamic-linking format that 0.27 cannot load. Do not bump without probing every grammar (`test/grammar.test.ts`).
- **Edge semantics v1**: direct calls, imports, name references, declared heritage (`extends`) and framework routes (`routes`) only, the `EdgeKind` union in `src/types.ts`. No type inference. Document precision limits in the README rather than working around them silently.

## Adding a language

Breadth-tier languages need four things, each small:

1. A registry row in `src/grammar/languages.ts`: the `LanguageId`, its extensions in `extensionLanguage`, its WASM file in `grammarFile` (must exist in the pinned `tree-sitter-wasms` bundle), and `tier: "generic"` in `languageTier`. Add the id to `LanguageId` in `src/types.ts`.
2. A query in `src/grammar/queries/<language>.ts` exporting a string in the tags convention: `@definition.<kind>` with a paired `@name`, and `@reference.call` with `@name`. Register it in `src/grammar/queries/index.ts`. Editing a query changes `extractionVersion`, so old caches rebuild.
3. A fixture under `test/fixtures/sample-repo/src/breadth/` with one container, one nested definition, one free function and one call.
4. A golden case in `test/extract.test.ts`, a parse snippet in `test/grammar.test.ts`, and a sample in `src/diagnostics/doctor.ts`.

Probe node names with `pnpm tsx -e` and `tree.rootNode.toString()` on the fixture. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm perf`.

## Code style

- TypeScript ESM, strict tsconfig chain including `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`. Optional properties are declared `?: T | undefined`.
- No comments unless asked or matching surrounding style.
- One adapter per language under `src/extract/`, kept small; the TS adapter is shared by typescript, tsx, and javascript.
- `no-console` is enforced by eslint outside `scripts/`.

## Reporting issues

Open a GitHub issue with the command you ran, the full error, and the osnova version (`osnova --help` footer or `package.json`). For extraction bugs, include a minimal snippet of the source that extracts incorrectly.
