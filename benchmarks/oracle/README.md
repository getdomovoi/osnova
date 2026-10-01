# Type-checker scoring harness

These scripts score Osnova's call edges against the language's own type checker or compiler, on a pinned checkout. They produce the numbers in [`../results/type-checker-oracle-2026-09-30.json`](../results/type-checker-oracle-2026-09-30.json) for six corpora (Python, TypeScript, Go, Java, Rust, C#). The earlier record, [`../results/type-checker-oracle-2026-09-21.json`](../results/type-checker-oracle-2026-09-21.json), scored click and zod only.

The unit is a call site: caller file, line and callee name. For every call the checker is asked for the callee's declarations. A site is in-checkout when at least one declaration is inside the checkout (on zod, 1 of 28,185 such sites also has a declaration outside it) and external when every declaration is outside. An edge is true when the checker resolves its site inside the checkout and the edge's target span holds one of the checker's declaration lines. It is false when the checker decided the site and no declaration falls in the span, including an in-checkout target where the checker says the callee is external. A claimed call line may sit one line from the checker's line for the same callee name. A site the checker did not decide, or did not enumerate, counts in neither rate. Recall is the share of the checker's in-checkout sites covered by at least one true edge.

Every truth script writes the same truth-file format, so `score.mjs` and `osnova-sites.mjs` serve all six languages:

```json
{
  "oracle": "javac",
  "oracleVersion": "27",
  "entries": [
    { "file": "src/A.java", "line": 12, "name": "load", "verdict": "in-repo", "defs": [{ "file": "src/B.java", "line": 40 }] }
  ]
}
```

`line` is the line of the callee name. `verdict` is `in-repo` or `external` (the Python and Rust scripts also write `undecided` entries, which the scorer skips); `defs` lists the in-checkout declaration lines, the declaration's name line except for TypeScript, which records the declaration's first line.

## Files

| File | Role |
| --- | --- |
| `sites-python.py` | Lists every Python call site (callee position in UTF-16 columns, as LSP counts them) |
| `truth-python.mjs` | Asks `pyright-langserver` for the definition at each Python site |
| `truth-typescript.mjs` | Resolves every TypeScript call and `new` expression with the TypeScript compiler API |
| `zod-paths.json` | Module paths for the zod checkout, in tsconfig `paths` form |
| `truth-go/` | Loads every Go package with `golang.org/x/tools/go/packages` (pinned in `go.mod` and `go.sum`) and resolves every call with `go/types` |
| `TruthJava.java` | Resolves every method invocation and `new` expression with the javac Compiler Tree API, one javac task per build module |
| `gson-units.properties` | The gson modules: the source roots each compiles and the sibling roots it reads |
| `sites-rust.mjs` | Lists every Rust call site with the tree-sitter Rust grammar Osnova uses (UTF-16 columns) |
| `truth-rust.mjs` | Asks `rust-analyzer` for the definition at each Rust site once it reports the workspace loaded |
| `lsp.mjs` | The stdio Language Server Protocol client both LSP-driven scripts share |
| `truth-csharp/` | Replays every C# compilation of a real build with Roslyn (pinned in `packages.lock.json`) and binds every invocation and object creation |
| `truth-csharp/oracle-capture.targets` | MSBuild target that writes each compilation's csc arguments during that build |
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

Paths are relative to the checkout root with `/` separators. `line` is the 1-based line of the call. Osnova records the first line of the call expression, which is the callee name's line except in a call that spans lines before its name, such as a method chain written one call per line. `targetStartLine` and `targetEndLine` are the 1-based span of the definition the edge points to. There is one entry per resolved call edge; unresolved calls are left out. A call edge whose argument count fits several overloads of its target, or none, names no declaration, so `osnova-sites.mjs` leaves it out and counts it in `overloadUndetermined`; an edge whose count names one overload claims that overload's span.

## Reproducing the recorded numbers

The pinned revisions are in `../click-v1.json`, `../zod-v1.json` and `../corpora/{cobra,gson,humanizer,ripgrep}.json`. The recorded run used Osnova 0.11.0. Run `pnpm build` first, then write Osnova's edges for each checkout and score them against its truth file:

```sh
node benchmarks/oracle/osnova-sites.mjs --workspace <checkout> --output <corpus>-osnova.json --cache-dir <cache>
node benchmarks/oracle/score.mjs --oracle <corpus>-truth.json --sites <corpus>-osnova.json
```

The truth files come from the steps below. None of them writes into the checkout; the steps that need a build run it in a copy.

```sh
# Python (click): pyright 1.1.414 from npm
python3 benchmarks/oracle/sites-python.py <click> click-sites.json
node benchmarks/oracle/truth-python.mjs --root <click> --sites click-sites.json \
  --server <pyright package>/langserver.index.js --output click-truth.json --corpus click-v1

# TypeScript (zod): typescript 5.9.3 from npm
node benchmarks/oracle/truth-typescript.mjs --root <zod> --ts <typescript package>/lib/typescript.js \
  --paths benchmarks/oracle/zod-paths.json --output zod-truth.json --corpus zod-v1

# Go (cobra): Go 1.27.1; GOMODCACHE, GOCACHE and GOPATH may point anywhere outside the checkout
(cd benchmarks/oracle/truth-go && go build -o <bin>/truth-go .)
<bin>/truth-go -root <cobra> -goos darwin,windows -output cobra-truth.json -corpus cobra-v1

# Java (gson): JDK 27 and Maven 3.9.16; <copy> is a clone of the checkout, <empty jar> a jar with no classes
# that stands in for the sibling gson snapshot, whose sources the oracle reads instead
mvn -f <copy>/pom.xml -Dmaven.repo.local=<m2> install:install-file -Dfile=<empty jar> \
  -DgroupId=com.google.code.gson -DartifactId=gson -Dversion=2.14.1-SNAPSHOT -Dpackaging=jar
mvn -f <copy>/pom.xml -Dmaven.repo.local=<m2> -Denforcer.skip=true dependency:build-classpath \
  -Dmdep.outputFile=cp.txt -Dmdep.includeScope=test
mvn -f <copy>/pom.xml -Dmaven.repo.local=<m2> -pl proto io.github.ascopes:protobuf-maven-plugin:5.1.8:generate-test
java --add-exports jdk.compiler/com.sun.tools.javac.tree=ALL-UNNAMED benchmarks/oracle/TruthJava.java \
  --root <gson> --units benchmarks/oracle/gson-units.properties --build <copy> --output gson-truth.json --corpus gson-v1

# Rust (ripgrep): Rust 1.98.1 with rust-analyzer; rust-src-1.98.1.tar.xz from static.rust-lang.org/dist
(cd <ripgrep> && CARGO_HOME=<cargo home> cargo fetch --locked)
node benchmarks/oracle/sites-rust.mjs <ripgrep> ripgrep-sites.json
CARGO_HOME=<cargo home> node benchmarks/oracle/truth-rust.mjs --root <ripgrep> --sites ripgrep-sites.json \
  --sysroot-src <rust-src>/rust-src/lib/rustlib/src/rust/library --target-dir <target dir> \
  --output ripgrep-truth.json --corpus ripgrep-v1

# C# (humanizer): .NET SDK 10.0.401 (bash); <copy> is a clone of the checkout with global.json removed and
# net11.0 deleted from the target frameworks of src/Humanizer, src/Benchmarks, tests/Humanizer.Tests and
# tests/Humanizer.SourceGenerators.Tests, and set to net10.0 in
# tests/Humanizer.Analyzers.Tests/Humanizer.Analyzers.Tests.props: the SDK 11 preview global.json names is
# not installed.
export NBGV_GitEngine=Disabled
for project in "tests/Humanizer.Tests/Humanizer.Tests.csproj -f net10.0" \
  "tests/Humanizer.SourceGenerators.Tests/Humanizer.SourceGenerators.Tests.csproj -f net10.0" \
  tests/Humanizer.Analyzers.Tests/Humanizer.Analyzers.Tests.Roslyn38.csproj \
  tests/Humanizer.Analyzers.Tests/Humanizer.Analyzers.Tests.Roslyn48.csproj \
  tests/Humanizer.Analyzers.Tests/Humanizer.Analyzers.Tests.Roslyn414.csproj \
  "src/Benchmarks/Benchmarks.csproj -f net10.0" \
  tools/Humanizer.UnicodeDataGenerator/Humanizer.UnicodeDataGenerator.csproj \
  tools/docs/language-coverage/Humanizer.Docs.LanguageCoverage.csproj \
  tools/locale-probe-net48/locale-probe-net48.csproj; do
  (cd <copy> && dotnet build $project --no-incremental -p:TreatWarningsAsErrors=false -p:ProvideCommandLineArgs=true \
    -p:EmitCompilerGeneratedFiles=true -p:CustomAfterMicrosoftCommonTargets=<repo>/benchmarks/oracle/truth-csharp/oracle-capture.targets)
done
dotnet build benchmarks/oracle/truth-csharp/TruthCSharp.csproj -c Release --artifacts-path <artifacts>
dotnet <artifacts>/bin/TruthCSharp/release/TruthCSharp.dll --root <humanizer> --build <copy> \
  --output humanizer-truth.json --corpus humanizer-v1
```

On 2026-09-30, on the machine that made the recording, these steps reproduced the 2026-09-21 counts for click and zod unchanged, and two runs of each new oracle wrote byte-identical truth files (humanizer also after a full rebuild of the copy). pyright's answers depend on the Python environment it finds: on a second machine with the same pyright version, 3,212 click sites resolved inside the checkout instead of 3,208, with 0 false edges and recall 0.9039.

## Limits per language

- Python: an attribute call is placed at the attribute token; pyright answers from the environment it finds.
- TypeScript: one program over every TypeScript file with zod's module paths; a callee with no symbol (20,136 sites, mostly calls on values the program cannot type) is undecided.
- Go: one load per listed GOOS (darwin and windows on cobra); a file excluded by every listed build constraint is not enumerated. A call through a callee other than a name or a selector (30 sites on cobra) is counted but not listed. A function-valued variable or field is decided at its declaration.
- Java: every module compiles on the classpath (`module-info.java` is hidden from the source path) at JDK 27's language level. Calls javac inserts itself, implicit `super()` and enum constant creation, are skipped. An anonymous class creation is decided at the named type. Generated protobuf classes sit on the source path and count as external.
- Rust: rust-analyzer resolves for the host target with default features, so a function declared once per `#[cfg]` branch has one active declaration. Calls inside macro invocations are token trees to the grammar and are not listed.
- C#: the compilations are the ones a .NET SDK 10.0.401 build ran for net10.0 (net48 for the one tool that targets only it), source-generator output included; a file compiled by several projects is scored once, in the project whose folder holds it. The `website/` documentation examples, `tests/fixtures` and the file-based scripts under `tools/` are not compiled, so their sites are not enumerated.

## Limits

The checker is the reference, not ground truth: a site the checker cannot resolve is left out, and dynamic dispatch the checker cannot see is invisible to both sides. Recall counts only sites the checker resolves inside the checkout. A checker names one declaration: in a language with overloads it is the overload the call binds, so an edge to another overload of the same method counts false. Two calls of the same name on one line share one verdict, and a call that Osnova records at the first line of a multi-line chain can be matched, within the one-line tolerance, to a different call of that name; the record counts those false edges separately. The scripts never write into the checkout. They write the output files they are given, and `osnova-sites.mjs` also writes Osnova's index cache (to `--cache-dir` when given, otherwise the default cache directory).
