import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { behaviorSuite, evaluateBehavior, compareBehavior } from "./behavior.js";
import type { BehaviorTrial } from "./behavior.js";
import { fingerprint } from "./replay-manifest.js";

async function readInput(file: string): Promise<unknown> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("input must be a file at most 32 MiB");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error("input changed during read");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("input changed during read");
    return JSON.parse(buffer.toString("utf8"));
  } finally { await handle.close(); }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    input: { type: "string" }, baseline: { type: "string" }, output: { type: "string" },
    prepare: { type: "string" }, tasks: { type: "boolean" }, template: { type: "boolean" },
  } });
  const modes = [values.input !== undefined, values.prepare !== undefined, values.tasks === true, values.template === true];
  if (modes.filter(Boolean).length !== 1 || values.baseline !== undefined && values.input === undefined || values.output !== undefined && values.prepare !== undefined) throw new Error("choose --tasks, --template, --prepare NEW_DIRECTORY, or --input FILE [--baseline FILE] [--output FILE]");
  if (values.prepare !== undefined) {
    const destination = path.resolve(values.prepare);
    await fs.mkdir(destination);
    for (const [file, body] of Object.entries(behaviorSuite.files)) {
      const target = path.join(destination, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body, { flag: "wx" });
    }
    process.stdout.write(`Prepared fresh fixture: ${destination}\nSuite: ${behaviorSuite.fingerprint}\n`);
    return;
  }
  let result: unknown;
  if (values.tasks) result = behaviorSuite;
  else if (values.template) {
    const placeholder = "0".repeat(64);
    const trials: BehaviorTrial[] = behaviorSuite.tasks.map((task) => ({
      taskId: task.id, sample: 1, agent: "replace-with-agent-version", model: "replace-with-model-version", environment: placeholder,
      skill: placeholder, hooks: placeholder, sourceFingerprint: placeholder, provenance: "synthetic", complete: false,
      durationMs: 0, events: [], final: "", diff: "", review: task.checks.map((id) => ({ id, verdict: "unverified", evidence: [] })),
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
    }));
    result = { schemaVersion: 1, suiteFingerprint: behaviorSuite.fingerprint, trials };
  } else {
    const candidate = await readInput(values.input!);
    const report = evaluateBehavior(candidate);
    const comparison = values.baseline === undefined ? undefined : compareBehavior(report, evaluateBehavior(await readInput(values.baseline)));
    const sources = ["behavior.ts", "behavior-suite.ts", "behavior-cli.ts", "replay-manifest.ts", "tokenizer.ts", "../../pnpm-lock.yaml"];
    const scorerFingerprint = fingerprint(await Promise.all(sources.map(async (file) => [file, await fs.readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8")])));
    result = { ...report, scorerFingerprint, tokenizer: "cl100k_base", comparison };
    if (report.status !== "passed" || comparison?.regressions.length) process.exitCode = 2;
  }
  const encoded = JSON.stringify(result, null, 2) + "\n";
  if (values.output !== undefined) {
    await fs.writeFile(values.output, encoded, { flag: "wx" });
    process.stdout.write("Behavior report written.\n");
  } else process.stdout.write(encoded);
}

await main().catch(() => {
  process.stderr.write("Behavior evaluation failed: invalid arguments, input, comparison, or destination. No input payloads are printed.\n");
  process.exitCode = 2;
});
