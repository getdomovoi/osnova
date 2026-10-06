import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Parser } from "web-tree-sitter";
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
