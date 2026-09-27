# Benchmark records

Every file here is a frozen measurement with its corpus fingerprint. A record in this directory is cited by a tracked document, test or script and is the current evidence for the claim that cites it. A record under `superseded/` was replaced by a later measurement of the same line and is kept as provenance; nothing cites it. `test/docs-benchmark-citations.test.ts` holds both halves of that rule.

## Current records

| Record | What it measures | Cited by |
| --- | --- | --- |
| `resolution-coverage-2026-09-21b.json` | Call-site resolution coverage on the pinned checkouts | `README.md`, `docs/reference.md` |
| `type-checker-oracle-2026-09-21.json` | Call edge precision and recall against a type checker on click and zod | `README.md`, `docs/reference.md`, `CHANGELOG.md` |
| `grep-vs-graph-2026-09-21.json` | Nine hand-verified call-site sets, text search against the resolved graph | `README.md`, `docs/reference.md` |
| `receiver-boundary-census-2026-09-21.json` | Census of the call sites the graph does not resolve, by what the receiver lacks | `README.md` |
| `route-edges-2026-09-21.json` | Route edges on three pinned framework checkouts | `docs/reference.md`, `CHANGELOG.md` |
| `parse-profile-2026-09-21.json` | Build time by phase on the seven pinned checkouts | `docs/reference.md`, `CHANGELOG.md` |
| `grep-vs-graph-2026-09-17.json`, `grep-vs-graph-2026-09-18.json` | Earlier rounds of the same sets, cited by the changelog entries that introduced them | `CHANGELOG.md` |
| `development-baseline-2026-09-14.json` | The first development baseline on the authored corpus | `docs/reference.md` |
| `definition-ranking-2026-09-14.json` | The definition-ranking candidate and its receipts | `docs/reference.md` |
| `import-bindings-2026-09-14.json` | Two import-binding candidates and the regression found between them | `docs/reference.md` |
| `reexports-2026-09-14.json` | The re-export candidate with positive and negative cases | `docs/reference.md` |
| `receivers-2026-09-14.json` | The receiver-hint candidate and its unsupported cases | `docs/reference.md` |
| `refresh-optimization-2026-09-15.json` | Seven-sample refresh profiles before and after | `docs/reference.md` |
| `cross-file-payload-experiment-2026-09-15.json` | The bounded-MCP experiment that missed its retention gate | `docs/reference.md` |
| `graph-ranking-experiment-2026-09-14.json` | The graph-ranking adjustment that was measured and rejected | `docs/reference.md` |

## Superseded records

| Record | Replaced by | Note |
| --- | --- | --- |
| `resolution-coverage-2026-09-21.json` | `resolution-coverage-2026-09-21b.json` | Same date, same schema, measured at 0.7.0 before the decorator and `extends` edges landed; the reference table once printed these numbers while citing the later record |
| `resolution-coverage-2026-09-18b.json` | `resolution-coverage-2026-09-21b.json` | Measured at 0.6.2 |
| `resolution-coverage-2026-09-18a.json` | `resolution-coverage-2026-09-21b.json` | Measured at 0.6.1 |
| `resolution-coverage-2026-09-18.json` | `resolution-coverage-2026-09-21b.json` | Measured at 0.6.2 |
| `resolution-coverage-2026-09-17.json` | `resolution-coverage-2026-09-21b.json` | Measured at 0.5.0 |
| `artifact-split-2026-09-15.json` | `refresh-optimization-2026-09-15.json` | Baseline and optimized profiles from the artifact split work; the shipped outcome is in the refresh record |
| `core-format-9-2026-09-15.json` | `refresh-optimization-2026-09-15.json` | Section and query timings from the core format 9 work |
| `identifier-tier-2026-09-16.json` | `resolution-coverage-2026-09-21b.json` | The identifier-tier rule change and its outcome per corpus, folded into later coverage records |
| `scope-ranking-2026-09-15.json` | none, reverted | A scope-ranking change that was measured and reverted; kept so the negative result is not re-run |
