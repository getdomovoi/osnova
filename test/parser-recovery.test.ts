import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Parser } from "web-tree-sitter";
import { getParser, loadLanguage } from "../src/grammar/loader.js";
import { buildIndex } from "../src/index.js";
import { serializeArtifact, serializeSections } from "../src/index/serialize.js";

const pool = vi.hoisted(() => ({ workers: 0 }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class CountedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      pool.workers += 1;
    }
  }
  return { ...actual, Worker: CountedWorker };
});

// Raw-string templates nested past the Kotlin scanner's state buffer make the scanner call abort mid-parse,
// which leaves that parser resuming the abandoned parse for every later file.
const poisonSource = "val x = " + '"""${'.repeat(1500) + "\n";

let temporary: string;
let workspace: string;
let cacheDir: string;
const previousWorkers = process.env.OSNOVA_EXTRACT_WORKERS;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-recovery-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
  pool.workers = 0;
});

afterEach(async () => {
  if (previousWorkers === undefined) delete process.env.OSNOVA_EXTRACT_WORKERS;
  else process.env.OSNOVA_EXTRACT_WORKERS = previousWorkers;
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("parser recovery after an extraction failure", () => {
  it("indexes later files of a language after one file fails to parse", async () => {
    await fs.writeFile(path.join(workspace, "a-breaks.kt"), poisonSource);
    await fs.writeFile(path.join(workspace, "b-healthy.kt"), 'fun greet() {\n  println("hi")\n}\n');

    const index = await buildIndex(workspace, { cacheDir });

    const healthy = index.files.get("b-healthy.kt");
    expect(healthy?.diagnostics ?? []).toEqual([]);
    expect(healthy?.symbols.map((symbol) => symbol.name)).toContain("greet");
  });

  it("reports the failing file and only the failing file", async () => {
    await fs.writeFile(path.join(workspace, "a-breaks.kt"), poisonSource);
    await fs.writeFile(path.join(workspace, "b-healthy.kt"), 'fun greet() {\n  println("hi")\n}\n');

    const index = await buildIndex(workspace, { cacheDir });

    const failedPaths = (index.diagnostics ?? []).filter((entry) => entry.phase === "parse").map((entry) => entry.path);
    expect(failedPaths).toEqual(["a-breaks.kt"]);
  });
});

describe("parser cleanup after an extraction failure", () => {
  it("keeps the process alive and indexes later files when deleting the failed parser throws", async () => {
    await fs.writeFile(path.join(workspace, "a-breaks.kt"), poisonSource);
    await fs.writeFile(path.join(workspace, "b-healthy.kt"), 'fun greet() {\n  println("hi")\n}\n');
    process.env.OSNOVA_EXTRACT_WORKERS = "0";
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const deleteSpy = vi.spyOn(Parser.prototype, "delete").mockImplementation(() => {
      throw new Error("RuntimeError: memory access out of bounds");
    });
    try {
      const index = await buildIndex(workspace, { cacheDir });
      await new Promise((resolve) => setImmediate(resolve));

      expect(deleteSpy).toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      const healthy = index.files.get("b-healthy.kt");
      expect(healthy?.diagnostics ?? []).toEqual([]);
      expect(healthy?.symbols.map((symbol) => symbol.name)).toEqual(["greet"]);
    } finally {
      deleteSpy.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("bash files with many heredoc starts", () => {
  const lines = (count: number, line: (i: number) => string): string => Array.from({ length: count }, (_, i) => line(i)).join("\n") + "\n";
  const heavy: Record<string, string> = {
    "a-functions.sh": lines(200, (i) => `f${i}() { cat <<EOF\nEOF\n}`),
    "a-herestrings.sh": lines(250, (i) => `cat <<< "x${i}"`),
    "a-open.sh": lines(1000, (i) => `cat <<EOF\n\${x${i}}`),
    "a-one-line.sh": "cat " + Array.from({ length: 300 }, (_, i) => `<<DELIMITER_${i}`).join(" ") + "\n",
  };
  const healthy = ["b-one.sh", "b-two.sh", "b-three.sh"];

  it.each(["0", "2"])("indexes healthy sibling scripts cleanly with %s extract workers", async (workers) => {
    for (const [file, source] of Object.entries(heavy)) await fs.writeFile(path.join(workspace, file), source);
    for (const file of healthy) await fs.writeFile(path.join(workspace, file), `greet_${file.slice(2, -3)}() {\n  echo hi\n}\n`);
    process.env.OSNOVA_EXTRACT_WORKERS = workers;

    const index = await buildIndex(workspace, { cacheDir });

    expect(index.files.size).toBe(Object.keys(heavy).length + healthy.length);
    for (const file of healthy) {
      const card = index.files.get(file);
      expect(card?.diagnostics ?? [], file).toEqual([]);
      expect(card?.symbols.map((symbol) => symbol.name), file).toEqual([`greet_${file.slice(2, -3)}`]);
    }
    expect((index.diagnostics ?? []).filter((entry) => healthy.includes(entry.path))).toEqual([]);
  });
});

// The bash scanner stores every pending heredoc in the parser's 1024-byte scanner state buffer and checks
// the bound a few bytes short. Heredocs that stay pending together (a pipeline or list joined across lines)
// then write past the buffer into the parser's stack pointer, and the parse still returns a tree.
describe("bash heredocs pending past the scanner state buffer", () => {
  const lines = (count: number, line: (i: number) => string): string => Array.from({ length: count }, (_, i) => line(i)).join("\n") + "\n";
  const pending = (count: number, delimiter: string, joiner: string): string =>
    Array.from({ length: count }, () => `cat <<${delimiter}`).join(joiner) + "\n" + lines(count, () => `x\n${delimiter}`);
  const shapes: Record<string, string> = {
    functions: lines(200, (i) => `f${i}() { cat <<EOF\nEOF\n}`),
    herestrings: lines(250, (i) => `cat <<< "x${i}"`),
    open: lines(1000, (i) => `cat <<EOF\n\${x${i}}`),
    "one-line": "cat " + Array.from({ length: 300 }, (_, i) => `<<DELIMITER_${i}`).join(" ") + "\n",
    pipeline: pending(200, "E", " | "),
    "pipeline-lines": pending(200, "E", " |\n"),
    "and-list": pending(200, "E", " &&\n"),
    continued: pending(200, "E", " | \\\n"),
    "quoted-newline": pending(200, "E", ' "a\nb" |'),
    "long-delimiters": pending(135, "E".repeat(16), " | "),
    unterminated: "echo " + Array.from({ length: 200 }, () => "$(cat <<E").join(" | ") + "\n",
  };
  const healthySource = "greet() {\n  cat <<EOF\nhi $1\nEOF\n}\n";
  const cases = Object.keys(shapes).flatMap((shape) => ["0", "1"].map((workers) => [shape, workers] as const));

  it.each(cases)("indexes a script parsed right after the %s shape with %s extract workers", async (shape, workers) => {
    await fs.writeFile(path.join(workspace, "a-heavy.sh"), shapes[shape] ?? "");
    await fs.writeFile(path.join(workspace, "b-healthy.sh"), healthySource);
    process.env.OSNOVA_EXTRACT_WORKERS = workers;

    const index = await buildIndex(workspace, { cacheDir });

    expect(pool.workers).toBe(Number(workers));
    expect(index.files.size).toBe(2);
    const card = index.files.get("b-healthy.sh");
    expect(card?.diagnostics ?? []).toEqual([]);
    expect(card?.symbols.map((symbol) => symbol.name)).toEqual(["greet"]);
    expect((index.diagnostics ?? []).filter((entry) => entry.path === "b-healthy.sh")).toEqual([]);
  });

  it("parses with the shared parser after an overflowing script exactly as a fresh parser does", async () => {
    const parser = await getParser("bash");
    const fresh = new Parser();
    fresh.setLanguage(await loadLanguage("bash"));
    try {
      const expected = fresh.parse(healthySource);
      const baseline = expected?.rootNode.toString();
      expected?.delete();
      for (const shape of ["pipeline", "pipeline-lines", "long-delimiters", "unterminated"]) {
        const poisoned = parser.parse(shapes[shape] ?? "");
        expect(poisoned, shape).not.toBeNull();
        poisoned?.delete();
        const after = parser.parse(healthySource);
        expect(after?.rootNode.hasError, shape).toBe(false);
        expect(after?.rootNode.toString(), shape).toBe(baseline);
        after?.delete();
      }
    } finally {
      fresh.delete();
    }
  });

  it("publishes the same bytes from the pool and from sequential extraction", async () => {
    for (const [shape, source] of Object.entries(shapes)) await fs.writeFile(path.join(workspace, `a-${shape}.sh`), source);
    await fs.writeFile(path.join(workspace, "b-healthy.sh"), healthySource);
    process.env.OSNOVA_EXTRACT_WORKERS = "2";
    const pooled = await buildIndex(workspace, { cacheDir });
    process.env.OSNOVA_EXTRACT_WORKERS = "0";
    const sequential = await buildIndex(workspace, { cacheDir: path.join(temporary, "sequential-cache") });

    expect(pool.workers).toBe(2);
    expect(pooled.files.get("b-healthy.sh")?.symbols.map((symbol) => symbol.name)).toEqual(["greet"]);
    const overflowing = ["and-list", "continued", "long-delimiters", "pipeline", "pipeline-lines", "quoted-newline", "unterminated"];
    for (const shape of overflowing) expect(pooled.files.get(`a-${shape}.sh`)?.diagnostics, shape).toEqual([{ phase: "parse", path: `a-${shape}.sh`, code: "syntax-errors" }]);
    expect(pooled.diagnostics).toEqual(sequential.diagnostics);
    expect(serializeArtifact(pooled).equals(serializeArtifact(sequential))).toBe(true);
  });
});

describe("parser recovery inside the extract worker pool", () => {
  const poison = Array.from({ length: 10 }, (_, i) => `f${String(i * 4).padStart(2, "0")}.kt`);
  const healthy = Array.from({ length: 40 }, (_, i) => i).filter((i) => i % 4 !== 0).map((i) => `f${String(i).padStart(2, "0")}.kt`);

  async function writePoisonedWorkspace(): Promise<void> {
    for (const file of poison) await fs.writeFile(path.join(workspace, file), poisonSource);
    for (const file of healthy) await fs.writeFile(path.join(workspace, file), `fun fn_${file.slice(1, 3)}() {\n  println("${file}")\n}\n`);
  }

  it("keeps every healthy file of the language when poison files are spread across workers", async () => {
    await writePoisonedWorkspace();
    process.env.OSNOVA_EXTRACT_WORKERS = "3";

    const index = await buildIndex(workspace, { cacheDir });

    expect(pool.workers).toBe(3);
    expect(index.files.size).toBe(40);
    for (const file of healthy) {
      const card = index.files.get(file);
      expect(card?.diagnostics ?? [], file).toEqual([]);
      expect(card?.symbols.map((symbol) => symbol.name), file).toEqual([`fn_${file.slice(1, 3)}`]);
    }
    const diagnostics = index.diagnostics ?? [];
    expect(diagnostics.filter((entry) => entry.code === "extraction-failed").map((entry) => entry.path)).toEqual(poison);
    expect(diagnostics.filter((entry) => entry.phase === "parse").map((entry) => entry.path)).toEqual(poison);
  });

  it("publishes the same bytes from the pool and from sequential extraction", async () => {
    await writePoisonedWorkspace();
    process.env.OSNOVA_EXTRACT_WORKERS = "3";
    const pooled = await buildIndex(workspace, { cacheDir });
    expect(pool.workers).toBe(3);
    process.env.OSNOVA_EXTRACT_WORKERS = "0";
    const sequential = await buildIndex(workspace, { cacheDir: path.join(temporary, "sequential-cache") });
    expect(pool.workers).toBe(3);

    expect(pooled.diagnostics ?? []).toHaveLength(poison.length);
    expect(pooled.diagnostics).toEqual(sequential.diagnostics);
    expect(serializeArtifact(pooled).equals(serializeArtifact(sequential))).toBe(true);
    expect(serializeSections(pooled).edges.bytes.equals(serializeSections(sequential).edges.bytes)).toBe(true);
  });
});
