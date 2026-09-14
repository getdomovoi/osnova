# AGENTS.md

Conventions for agent sessions working in this repository.

## Workflow rules

- Run the code review skill before every push to remote. No push happens without a review pass first.
- Never commit, push, or publish without an explicit request.
- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before claiming done; `pnpm perf` when the engine or serialization changed.

## Invariants

- Scope update (2026-09-14): finish the standalone hardening roadmap before any integration work or integration discussion. Graph viewers and graph visualization UI are entirely out of scope. The implementation plan is `/Users/fetzy/.local/share/kilo/plans/1789340040608-osnova-context-engine.md`, including its standalone expansion section.
- Public-content boundary: keep competitor identities, repository URLs, and comparative research out of shipped docs, code comments, examples, generated output, commit messages, and PR/issue prose. Keep named competitive benchmarks and research in private local artifacts; public benchmarks describe Osnova independently. Do not copy third-party code requiring attribution that conflicts with this boundary; retain any legally required notices.

- Determinism is the core correctness property: incremental updates must equal full rebuilds byte-for-byte. Sort everything (paths, symbols, edges) before serialization; never add timestamps or nondeterministic fields to the artifact. The artifact is JSON, gzip above 4 MiB.
- The MCP tool names and argument shapes (`osnova_ask`, `osnova_find_text`, `osnova_skeleton`, `osnova_callers`, `osnova_map`) and the exported API (`buildIndex`, `loadIndex`, `applyChanges`, `freshness`, `ask`, `findText`, `skeleton`, `callers`, `map`, `renderMapCard`, `runMcpStdio`, `cacheDir` parameter, `OSNOVA_CACHE_DIR`) are a frozen contract for a downstream consumer. Breaking them requires a coordinated major version, never a surprise.
- Read-only contract: no writes outside the cache directory, no network, no telemetry.

## Code conventions

- TypeScript ESM, strict tsconfig chain (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`, `verbatimModuleSyntax`). Optional properties are declared `?: T | undefined`.
- No comments unless asked or matching surrounding style.
- Extraction adapters stay small and golden-tested in `test/extract.test.ts`. One adapter per language under `src/extract/`; the TS adapter is shared by typescript, tsx, and javascript.
- web-tree-sitter is pinned exactly (0.25.10) because the prebuilt grammars in `tree-sitter-wasms@0.1.13` use the older dynamic-linking format; 0.27 fails with a `getDylinkMetadata` error. Do not bump without probing every grammar first (`test/grammar.test.ts` does this).
- Edge semantics v1: direct calls, imports, name references only. No type inference. Resolution preference: same file, then files reached by the file's resolved imports, then unique name within the language family. Ambiguous candidates at the preferred tier remain unresolved; persist the resolution basis and never label a name heuristic as type-proven evidence.
- TypeScript/JavaScript and Python binding hints take precedence over name heuristics. Blocked bindings and missing bound targets must not fall through to global matches. Preserve binding metadata when rebuilding raw edges, and include it in same-line edge identity so incremental updates retain distinct scope states.
- Re-export lookup preserves explicit-name precedence, wildcard ambiguity and source-hop evidence. Cycles and traversal budgets must terminate without claiming unknown paths are empty. Cache export lookup only within one complete resolution pass so changed barrels cannot reuse stale results.
- TypeScript/JavaScript/Python member calls require a receiver hint or a namespace binding; never restore method-name fallback for unknown objects. Receiver hints identify declared owners, not runtime types. Preserve static/instance, lexical-this and decorator boundaries, and keep unsupported value/alias/mutation flow explicit.
- Tree output strings from `renderMapCard` default to a 16,384-code-unit cap with elastic drop order: hotspot lines first, then hub lines, then cluster lines. Preserve the header where the requested budget permits; zero returns an empty card. CLI/MCP text payloads have a separate 16,384-code-unit presentation cap with explicit clipping notices.

## Test layout

- `test/extract.test.ts`: per-language goldens against `test/fixtures/sample-repo`.
- `test/incremental.test.ts`: determinism and the randomized incremental-equals-full property test.
- `test/query.test.ts`: ask, findText, skeleton, callers, map, mapCard.
- `test/cli.test.ts`, `test/mcp.test.ts`: round-trips; MCP uses `InMemoryTransport`.
- `test/selfhost.test.ts`: osnova indexes its own source tree.
- `scripts/perf.mjs`: performance budgets; must stay green in CI.
