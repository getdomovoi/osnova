# Type-checker scoring harness

These scripts score Osnova's call edges against the language's own type checker, on a pinned checkout. They produce the numbers in [`../results/type-checker-oracle-2026-09-21.json`](../results/type-checker-oracle-2026-09-21.json).

The unit is a call site: caller file, line and callee name. For every call the checker is asked for the callee's declarations. A site is in-checkout when at least one declaration is inside the checkout (on zod, 1 of 28,185 such sites also has a declaration outside it) and external when every declaration is outside. An edge is true when the checker resolves its site inside the checkout and the edge's target span holds one of the checker's declaration lines. It is false when the checker decided the site and no declaration falls in the span, including an in-checkout target where the checker says the callee is external. A claimed call line may sit one line from the checker's line for the same callee name. A site the checker did not decide, or did not enumerate, counts in neither rate. Recall is the share of the checker's in-checkout sites covered by at least one true edge.

## Files

| File | Role |
| --- | --- |
| `sites-python.py` | Lists every Python call site (callee position in UTF-16 columns, as LSP counts them) |
| `truth-python.mjs` | Asks `pyright-langserver` for the definition at each Python site |
| `truth-typescript.mjs` | Resolves every TypeScript call and `new` expression with the TypeScript compiler API |
| `zod-paths.json` | Module paths for the zod checkout, in tsconfig `paths` form |
| `osnova-sites.mjs` | Writes Osnova's resolved call edges in the claimed-sites format |
| `score.mjs` | Scores a claimed-sites file against a truth file |

## Claimed-sites format

`score.mjs` reads the edges to score from one JSON file, which `osnova-sites.mjs` writes:

```json
{
  "tool": "osnova",
  "sites": [
    { "callerFile": "src/a.py", "line": 12, "calleeName": "load", "targetFile": "src/b.py",
      "targetName": "load", "targetStartLine": 40, "targetEndLine": 58 }
  ]
}
```

Paths are relative to the checkout root with `/` separators. `line` is the 1-based line of the callee name at the call. `targetStartLine` and `targetEndLine` are the 1-based span of the definition the edge points to. There is one entry per resolved call edge; unresolved calls are left out. A call edge whose argument count fits several overloads of its target, or none, names no declaration, so `osnova-sites.mjs` leaves it out and counts it in `overloadUndetermined`; an edge whose count names one overload claims that overload's span.

## Reproducing the recorded numbers

Pinned checkouts: click `6aabf099bfdd4c1e75fe8d0e0d4241372b988ab1` and zod `59bbc03e10c636b9eb3c393dfeb552819774ec21` (see `../click-v1.json` and `../zod-v1.json`). The recorded run used pyright 1.1.414 and TypeScript 5.9.3. Run `pnpm build` first.

```sh
# Python (click)
python3 benchmarks/oracle/sites-python.py <click> click-sites.json
node benchmarks/oracle/truth-python.mjs --root <click> --sites click-sites.json \
  --server <pyright>/dist/langserver.index.js --output click-truth.json --corpus click-v1
node benchmarks/oracle/osnova-sites.mjs --workspace <click> --output click-osnova.json
node benchmarks/oracle/score.mjs --oracle click-truth.json --sites click-osnova.json

# TypeScript (zod)
node benchmarks/oracle/truth-typescript.mjs --root <zod> --ts <typescript>/lib/typescript.js \
  --paths benchmarks/oracle/zod-paths.json --output zod-truth.json --corpus zod-v1
node benchmarks/oracle/osnova-sites.mjs --workspace <zod> --output zod-osnova.json
node benchmarks/oracle/score.mjs --oracle zod-truth.json --sites zod-osnova.json
```

On 2026-09-29, on the machine that made the recording, these steps reproduced every count in the recorded file with Osnova 0.10.0: click 2,903 claimed edges, 0 false, recall 0.9038; zod 21,630 claimed edges, 4 false, recall 0.7693. pyright's answers depend on the Python environment it finds: on a second machine with the same pyright version, 3,212 click sites resolved inside the checkout instead of 3,208, with 0 false edges and recall 0.9039.

## Limits

The checker is the reference, not ground truth: a site the checker cannot resolve is left out, and dynamic dispatch the checker cannot see is invisible to both sides. Recall counts only sites the checker resolves inside the checkout. The scripts never write into the checkout. They write the output files they are given, and `osnova-sites.mjs` also writes Osnova's index cache (to `--cache-dir` when given, otherwise the default cache directory).
