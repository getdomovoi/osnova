#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyChanges, ask, buildIndex, freshness, loadIndex, refreshWorkspace, scanFiles, scopedAsk, serializeArtifact } from "../dist/index.js";

const PACKAGES = 16;
const MODULES = 12;
const FUNCTIONS = 6;
const BUILD_WORKERS = "2";
const GENEROUS = { build: 20_000, incremental: 5_000, coreLoad: 500, scan: 200, coldGround: 1_500, edgesLoad: 500, noChangeRefresh: 400, changedRefresh: 4_000, scopedAsk: 150, peakRssMiB: 3_072 };
const BUDGETS = { linux: GENEROUS, darwin: GENEROUS, win32: GENEROUS };
const POLYGLOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "sample-repo");

function write(root, rel, lines) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function typescript(root) {
  write(root, "ts/core/store.ts", [
    "export interface Entity { readonly id: number; }",
    "export class Store<T extends Entity> {",
    "  private readonly items = new Map<number, T>();",
    "  get(id: number): T | undefined { return this.items.get(id); }",
    "  put(item: T): void { this.items.set(item.id, item); }",
    "  values(): T[] { return [...this.items.values()]; }",
    "  get size(): number { return this.items.size; }",
    "}",
    "export function clamp(value: number, low = 0, high = 1): number { return Math.min(high, Math.max(low, value)); }",
  ]);
  for (let p = 0; p < PACKAGES; p += 1) {
    const barrel = [];
    for (let m = 0; m < MODULES; m += 1) {
      const id = `${p}_${m}`;
      const next = `${p}_${(m + 1) % MODULES}`;
      const lines = [
        'import { Store, clamp } from "../core/store.js";',
        'import type { Entity } from "../core/store.js";',
        `import { chain${next} } from "./mod${(m + 1) % MODULES}.js";`,
        ...(p > 0 ? [`import * as upstream from "../pkg${p - 1}/index.js";`] : []),
        "",
        "function logged<T>(target: T, _context: unknown): T { return target; }",
        "",
        `export interface Record${id} extends Entity {`,
        "  readonly name: string;",
        "  readonly tags: readonly string[];",
        "  readonly weight: number;",
        "}",
        "",
        `export enum Kind${id} { Alpha = "alpha", Beta = "beta", Gamma = "gamma" }`,
        "",
        `export abstract class Base${id} {`,
        "  protected abstract label(): string;",
        "  describe(): string { return `${this.label()} ready`; }",
        "}",
        "",
        `export class Service${id} extends Base${id} {`,
        `  private readonly store = new Store<Record${id}>();`,
        "  constructor(private readonly prefix: string) { super(); }",
        "  protected label(): string { return this.prefix; }",
        "  @logged",
        `  find(id: number): Record${id} | undefined { return this.store.get(id); }`,
        `  add(record: Record${id}): void { this.store.put({ ...record, weight: clamp(record.weight) }); }`,
        "  names(): string[] { return this.store.values().map((record) => this.format(record)); }",
        `  total(): number { return this.store.values().reduce((sum, record) => sum + record.weight, 0); }`,
        `  private format(record: Record${id}): string { return \`\${this.prefix}:\${record.name}:\${record.tags.join("|")}\`; }`,
        "}",
        "",
        `export function build${id}(count: number): Service${id} {`,
        `  const service = new Service${id}("p${id}");`,
        "  for (let i = 0; i < count; i += 1) service.add({ id: i, name: `n${i}`, tags: [], weight: i / count });",
        "  return service;",
        "}",
        "",
        `export function chain${id}(value: number): number {`,
        `  return value <= 0 ? 0 : chain${next}(value - 1) + 1;`,
        "}",
        "",
        `export namespace Registry${id} {`,
        "  export const LIMIT = 10;",
        `  export function register(service: Service${id}): number { return Math.min(LIMIT, service.names().length); }`,
        "}",
        "",
      ];
      for (let f = 0; f < FUNCTIONS; f += 1) {
        lines.push(
          `export function handler${id}_${f}(input: readonly number[]): number {`,
          `  const service = build${id}(input.length);`,
          `  const kind = input.length % 2 === 0 ? Kind${id}.Alpha : Kind${id}.Beta;`,
          `  const base = Registry${id}.register(service) + chain${id}(${f});`,
          ...(p > 0 ? [`  const shared = upstream.build${p - 1}_${m}(${f}).total();`] : ["  const shared = 0;"]),
          `  return kind === Kind${id}.Alpha ? base + shared : service.total() - shared;`,
          "}",
          "",
        );
      }
      write(root, `ts/pkg${p}/mod${m}.ts`, lines);
      barrel.push(`export * from "./mod${m}.js";`);
    }
    barrel.push(`export { Service${p}_0 as PrimaryService } from "./mod0.js";`);
    write(root, `ts/pkg${p}/index.ts`, barrel);
  }
}

function python(root) {
  write(root, "py/__init__.py", ['"""Generated perf corpus."""']);
  write(root, "py/core/__init__.py", ["from .store import Store, clamp", "", '__all__ = ["Store", "clamp"]']);
  write(root, "py/core/store.py", [
    "from __future__ import annotations",
    "",
    "from typing import Generic, Iterator, TypeVar",
    "",
    'T = TypeVar("T")',
    "",
    "",
    "def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:",
    "    return min(high, max(low, value))",
    "",
    "",
    "class Store(Generic[T]):",
    "    def __init__(self) -> None:",
    "        self.items: dict[int, T] = {}",
    "",
    "    def get(self, key: int) -> T | None:",
    "        return self.items.get(key)",
    "",
    "    def put(self, key: int, item: T) -> None:",
    "        self.items[key] = item",
    "",
    "    def values(self) -> Iterator[T]:",
    "        return iter(self.items.values())",
  ]);
  for (let p = 0; p < PACKAGES; p += 1) {
    const init = [];
    for (let m = 0; m < MODULES; m += 1) {
      const id = `${p}_${m}`;
      const nextModule = (m + 1) % MODULES;
      const lines = [
        "from __future__ import annotations",
        "",
        "import functools",
        "from dataclasses import dataclass",
        "from typing import Iterable",
        "",
        "from ..core.store import Store, clamp",
        `from . import mod${nextModule} as sibling`,
        ...(p > 0 ? [`from ..pkg${p - 1}.mod${m} import build${p - 1}_${m} as upstream_build`] : []),
        "",
        "",
        "@dataclass(frozen=True)",
        `class Record${id}:`,
        "    id: int",
        "    name: str",
        "    tags: tuple[str, ...] = ()",
        "    weight: float = 1.0",
        "",
        "",
        `class Base${id}:`,
        "    def label(self) -> str:",
        "        raise NotImplementedError",
        "",
        "    def describe(self) -> str:",
        '        return f"{self.label()} ready"',
        "",
        "",
        `class Service${id}(Base${id}):`,
        "    def __init__(self, prefix: str) -> None:",
        "        self.prefix = prefix",
        `        self.store: Store[Record${id}] = Store()`,
        "",
        "    def label(self) -> str:",
        "        return self.prefix",
        "",
        "    @functools.lru_cache(maxsize=128)",
        `    def find(self, key: int) -> Record${id} | None:`,
        "        return self.store.get(key)",
        "",
        `    def add(self, record: Record${id}) -> None:`,
        "        self.store.put(record.id, record)",
        "",
        "    @property",
        "    def names(self) -> list[str]:",
        "        return [self._format(record) for record in self.store.values()]",
        "",
        "    @staticmethod",
        `    def weigh(records: Iterable[Record${id}]) -> float:`,
        "        return sum(clamp(record.weight) for record in records)",
        "",
        "    def total(self) -> float:",
        "        return self.weigh(self.store.values())",
        "",
        `    def _format(self, record: Record${id}) -> str:`,
        '        return f"{self.prefix}:{record.name}"',
        "",
        "",
        `def build${id}(count: int) -> Service${id}:`,
        `    service = Service${id}("p${id}")`,
        "    for i in range(count):",
        `        service.add(Record${id}(i, f"n{i}", (), i / max(count, 1)))`,
        "    return service",
        "",
        "",
        `def chain${id}(value: int) -> int:`,
        `    return 0 if value <= 0 else sibling.chain${p}_${nextModule}(value - 1) + 1`,
        "",
      ];
      for (let f = 0; f < FUNCTIONS; f += 1) {
        lines.push(
          "",
          `def handler${id}_${f}(values: list[int]) -> float:`,
          `    service = build${id}(len(values))`,
          `    base = chain${id}(${f}) + len(service.names)`,
          ...(p > 0 ? [`    shared = upstream_build(${f}).total()`] : ["    shared = 0.0"]),
          "    return base + shared if values else service.total() - shared",
          "",
        );
      }
      write(root, `py/pkg${p}/mod${m}.py`, lines);
      init.push(`from .mod${m} import Service${id}, build${id}`);
    }
    write(root, `py/pkg${p}/__init__.py`, init);
  }
}

function go(root) {
  write(root, "go/go.mod", ["module example.com/perf", "", "go 1.22"]);
  write(root, "go/core/store.go", [
    "package core",
    "",
    "type Store struct {",
    "\tnames map[string]int",
    "}",
    "",
    "func NewStore() *Store {",
    "\treturn &Store{names: map[string]int{}}",
    "}",
    "",
    "func (s *Store) Put(name string) {",
    "\ts.names[name]++",
    "}",
    "",
    "func (s *Store) Count(name string) int {",
    "\treturn s.names[name]",
    "}",
    "",
    "func Clamp(value, low, high float64) float64 {",
    "\tif value < low {",
    "\t\treturn low",
    "\t}",
    "\tif value > high {",
    "\t\treturn high",
    "\t}",
    "\treturn value",
    "}",
  ]);
  for (let p = 0; p < PACKAGES; p += 1) {
    for (let m = 0; m < MODULES; m += 1) {
      const next = (m + 1) % MODULES;
      const lines = [
        `package pkg${p}`,
        "",
        "import (",
        '\t"fmt"',
        '\t"sort"',
        '\t"strings"',
        "",
        '\t"example.com/perf/core"',
        ...(p > 0 ? [`\tupstream "example.com/perf/pkg${p - 1}"`] : []),
        ")",
        "",
        `type Record${m} struct {`,
        "\tID     int",
        "\tName   string",
        "\tTags   []string",
        "\tWeight float64",
        "}",
        "",
        `type Service${m} struct {`,
        "\tprefix string",
        "\tstore  *core.Store",
        `\titems  map[int]Record${m}`,
        "}",
        "",
        `func NewService${m}(prefix string) *Service${m} {`,
        `\treturn &Service${m}{prefix: prefix, store: core.NewStore(), items: map[int]Record${m}{}}`,
        "}",
        "",
        `func (s *Service${m}) Find(id int) (Record${m}, bool) {`,
        "\trecord, ok := s.items[id]",
        "\treturn record, ok",
        "}",
        "",
        `func (s *Service${m}) Add(record Record${m}) {`,
        "\trecord.Weight = core.Clamp(record.Weight, 0, 1)",
        "\ts.items[record.ID] = record",
        "\ts.store.Put(record.Name)",
        "}",
        "",
        `func (s *Service${m}) Names() []string {`,
        "\tout := make([]string, 0, len(s.items))",
        "\tfor _, record := range s.items {",
        "\t\tout = append(out, s.format(record))",
        "\t}",
        "\tsort.Strings(out)",
        "\treturn out",
        "}",
        "",
        `func (s *Service${m}) Total() float64 {`,
        "\ttotal := 0.0",
        "\tfor _, record := range s.items {",
        "\t\ttotal += record.Weight",
        "\t}",
        "\treturn total",
        "}",
        "",
        `func (s *Service${m}) format(record Record${m}) string {`,
        '\treturn fmt.Sprintf("%s:%s", s.prefix, strings.ToUpper(record.Name))',
        "}",
        "",
        `func Build${m}(count int) *Service${m} {`,
        `\tservice := NewService${m}("p${p}_${m}")`,
        "\tfor i := 0; i < count; i++ {",
        `\t\tservice.Add(Record${m}{ID: i, Name: fmt.Sprint(i), Weight: float64(i) / float64(count+1)})`,
        "\t}",
        "\treturn service",
        "}",
        "",
        `func Chain${m}(value int) int {`,
        "\tif value <= 0 {",
        "\t\treturn 0",
        "\t}",
        `\treturn Chain${next}(value-1) + 1`,
        "}",
      ];
      for (let f = 0; f < FUNCTIONS; f += 1) {
        lines.push(
          "",
          `func Handler${m}_${f}(values []int) float64 {`,
          `\tservice := Build${m}(len(values))`,
          `\tbase := float64(Chain${m}(${f}) + len(service.Names()))`,
          ...(p > 0 ? [`\tshared := upstream.Build${m}(${f}).Total()`] : ["\tshared := 0.0"]),
          "\tif len(values) > 0 {",
          "\t\treturn base + shared",
          "\t}",
          "\treturn service.Total() - shared",
          "}",
        );
      }
      write(root, `go/pkg${p}/mod${m}.go`, lines);
    }
  }
}

function generate(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  typescript(root);
  python(root);
  go(root);
  fs.cpSync(POLYGLOT, path.join(root, "polyglot"), { recursive: true });
}

function sourceBytes(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return total;
}

async function timed(action) {
  const start = performance.now();
  const value = await action();
  return [value, performance.now() - start];
}

function calibrate() {
  let best = Infinity;
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now();
    const rows = Array.from({ length: 60_000 }, (_, i) => ({ id: i, name: `n${(i * 7919) % 60_000}`, tags: [`t${i % 17}`, `u${i % 31}`] }));
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
    const byTag = new Map();
    for (const row of rows) for (const tag of row.tags) byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
    if (JSON.parse(JSON.stringify(rows)).length !== rows.length || byTag.size !== 48) throw new Error("perf: calibration workload is broken");
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

function edgesLoaded(index) {
  if (typeof index.edgesLoaded !== "function") throw new Error("perf: the index no longer reports edgesLoaded(), so the edge-section gate cannot run");
  return index.edgesLoaded();
}

async function main() {
  const budgets = BUDGETS[process.platform] ?? BUDGETS.linux;
  const calibrationMs = calibrate();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-perf-"));
  const cacheDir = path.join(root, "cache");
  const repo = path.join(root, "repo");
  generate(repo);
  const corpusBytes = sourceBytes(repo);
  const expectedFiles = fs.readdirSync(repo, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name !== ".gitignore").length;
  const failures = [];

  const requestedWorkers = process.env.OSNOVA_EXTRACT_WORKERS;
  process.env.OSNOVA_EXTRACT_WORKERS = BUILD_WORKERS;
  const [built, buildMs] = await timed(() => buildIndex(repo, { cacheDir }));
  if (requestedWorkers === undefined) delete process.env.OSNOVA_EXTRACT_WORKERS;
  else process.env.OSNOVA_EXTRACT_WORKERS = requestedWorkers;
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  const artifactBytes = serializeArtifact(built).length;
  const symbolsByLanguage = new Map();
  for (const card of built.files.values()) symbolsByLanguage.set(card.language, (symbolsByLanguage.get(card.language) ?? 0) + card.symbols.length);
  for (const language of ["typescript", "python", "go"]) {
    const count = symbolsByLanguage.get(language) ?? 0;
    if (count < PACKAGES * MODULES * FUNCTIONS) failures.push(`${language} yielded only ${count} symbols`);
  }
  if ((built.diagnostics ?? []).length > 0) failures.push(`build reported ${built.diagnostics.length} diagnostics`);

  const [scan, scanMs] = await timed(() => scanFiles(repo));
  if (scan.paths.length !== expectedFiles) failures.push(`scan found ${scan.paths.length} files, expected ${expectedFiles}`);

  const [loaded, coreLoadMs] = await timed(async () => {
    const index = await loadIndex(repo, { cacheDir });
    if (index === undefined) throw new Error("perf: core load returned undefined");
    return index.files.size > 0 ? index : undefined;
  });
  if (loaded === undefined) throw new Error("perf: core load returned no files");
  const [, coldGroundMs] = await timed(() => ask(loaded, "chain service registry", { limit: 8 }));
  if (edgesLoaded(loaded)) failures.push("a cold ground query loaded the edge section");
  const [edgeCount, edgesLoadMs] = await timed(() => loaded.edges.length);
  if (edgeCount !== built.edges.length) failures.push(`edge section holds ${edgeCount} edges, the build ${built.edges.length}`);
  scopedAsk(loaded, "chain service", { limit: 8 });
  const [, scopedAskMs] = await timed(() => scopedAsk(loaded, "chain service", { limit: 8 }));

  const warmups = ["ts/pkg0/mod0.ts", "py/pkg0/mod0.py", "go/pkg0/mod0.go"];
  for (const file of warmups) fs.appendFileSync(path.join(repo, file), "\n");
  let index = await applyChanges(built, repo, warmups);
  const edited = [];
  for (let m = 0; m < 10; m += 1) {
    const file = [`ts/pkg1/mod${m}.ts`, `py/pkg1/mod${m}.py`, `go/pkg1/mod${m}.go`][m % 3];
    fs.appendFileSync(path.join(repo, file), [
      `export function extra${m}(v: number): number { return v + ${m}; }\n`,
      `\n\ndef extra${m}(v: int) -> int:\n    return v + ${m}\n`,
      `\nfunc Extra${m}(v int) int {\n\treturn v + ${m}\n}\n`,
    ][m % 3]);
    edited.push(file);
  }
  const [report, incrementalMs] = await timed(async () => {
    const found = await freshness(index, repo);
    index = await applyChanges(index, repo, [...found.added, ...found.changed, ...found.deleted]);
    return found;
  });
  if (report.changed.length !== edited.length) failures.push(`freshness found ${report.changed.length} changed files, expected ${edited.length}`);

  await refreshWorkspace(repo, { cacheDir });
  const [unchanged, noChangeRefreshMs] = await timed(() => refreshWorkspace(repo, { cacheDir }));
  if (edgesLoaded(unchanged)) failures.push("a no-change refresh loaded the edge section");

  const probe = "ts/pkg2/mod3.ts";
  fs.appendFileSync(path.join(repo, probe), "export function perfProbeMarker(v: number): number { return v + 1; }\n");
  const [changed, changedRefreshMs] = await timed(() => refreshWorkspace(repo, { cacheDir }));
  if (!changed.files.get(probe)?.text.includes("perfProbeMarker")) failures.push("changed refresh missed the edit");

  const measured = { build: buildMs, incremental: incrementalMs, coreLoad: coreLoadMs, scan: scanMs, coldGround: coldGroundMs, edgesLoad: edgesLoadMs, noChangeRefresh: noChangeRefreshMs, changedRefresh: changedRefreshMs, scopedAsk: scopedAskMs };
  for (const [name, ms] of Object.entries(measured)) {
    if (ms > budgets[name]) failures.push(`${name} ${ms.toFixed(0)}ms > ${budgets[name]}ms`);
  }
  if (peakRssMiB > budgets.peakRssMiB) failures.push(`peakRss ${peakRssMiB.toFixed(0)}MiB > ${budgets.peakRssMiB}MiB`);

  console.log(`files: ${built.files.size} symbols: ${built.symbols.size} edges: ${built.edges.length} source: ${(corpusBytes / 1048576).toFixed(2)}MiB languages: ${symbolsByLanguage.size} workers: ${BUILD_WORKERS} calibration: ${calibrationMs.toFixed(0)}ms`);
  console.log(`${Object.entries(measured).map(([name, ms]) => `${name}: ${ms.toFixed(0)}ms`).join(" ")} artifact: ${(artifactBytes / 1024).toFixed(0)}KiB peakRss: ${peakRssMiB.toFixed(0)}MiB`);
  console.log(`budget use (${process.platform}): ${[...Object.entries(measured).map(([name, ms]) => `${name} ${(100 * ms / budgets[name]).toFixed(0)}%`), `peakRss ${(100 * peakRssMiB / budgets.peakRssMiB).toFixed(0)}%`].join(" ")}`);

  fs.rmSync(root, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error(`perf budget exceeded: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("perf budgets met");
}

await main();
