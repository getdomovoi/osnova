import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { parseManifest, manifestFingerprint } from "./manifest.js";
import { validateCandidate } from "./evaluation.js";
import { scanFiles } from "../../src/index/scan.js";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));

async function implementationIdentity(): Promise<{ revision: string | null; engineFingerprint: string; harnessFingerprint: string }> {
  const engine = createHash("sha256");
  const harness = createHash("sha256");
  const { paths } = await scanFiles(repository);
  for (const relative of paths) {
    const hash = relative.startsWith("src/") || relative === "package.json" || relative === "pnpm-lock.yaml" ? engine
      : relative.startsWith("scripts/bench/") ? harness : null;
    if (hash === null) continue;
    hash.update(JSON.stringify([relative, createHash("sha256").update(await fs.readFile(path.join(repository, relative))).digest("hex")]));
  }
  let revision: string | null = null;
  try {
    revision = (await execute("git", ["-C", repository, "rev-parse", "HEAD"], { timeout: 10_000 })).stdout.trim();
  } catch {
    revision = null;
  }
  return { revision, engineFingerprint: engine.digest("hex"), harnessFingerprint: harness.digest("hex") };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    manifest: { type: "string" }, workspace: { type: "string" }, split: { type: "string", default: "development" },
    samples: { type: "string", default: "5" }, output: { type: "string" }, worker: { type: "boolean" },
    "temporary-root": { type: "string" },
    "candidate-report": { type: "string" },
  } });
  const manifestPath = path.resolve(values.manifest ?? path.join(repository, "benchmarks/core-v1.json"));
  if (values.split !== "development" && values.split !== "evaluation") throw new Error("split must be development or evaluation");
  if (values.split === "evaluation" && values["candidate-report"] === undefined) {
    throw new Error("evaluation requires --candidate-report from the matching development run");
  }
  if (values.split === "development" && values["candidate-report"] !== undefined) throw new Error("candidate reports apply only to evaluation");
  if (values.worker === true) {
    const manifest = parseManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
    const identity = await implementationIdentity();
    const receipt = values["candidate-report"] === undefined ? null : validateCandidate(
      JSON.parse(await fs.readFile(values["candidate-report"], "utf8")), {
        corpus: manifest.id, manifestFingerprint: manifestFingerprint(manifest),
        engineFingerprint: identity.engineFingerprint, harnessFingerprint: identity.harnessFingerprint,
        developmentCaseIds: manifest.cases.filter((item) => item.split === "development").map((item) => item.id),
        environment: { node: process.version, platform: process.platform, arch: process.arch },
      },
    );
    const { runBenchmark } = await import("./runner.js");
    const result = await runBenchmark(manifest, {
      samples: Number(values.samples), split: values.split, workspace: values.workspace, temporaryRoot: values["temporary-root"],
      expectedSnapshotFingerprint: receipt?.snapshotFingerprint,
    });
    const after = await implementationIdentity();
    if (identity.engineFingerprint !== after.engineFingerprint || identity.harnessFingerprint !== after.harnessFingerprint) {
      result.status = "failed";
      result.errors.push("implementation changed during benchmark");
    }
    process.stdout.write(JSON.stringify({ ...result, isolation: "fresh-process", execution: "tsx-source", implementation: identity, evaluationReceipt: receipt }) + "\n");
    return;
  }
  const args = ["--import", "tsx", fileURLToPath(import.meta.url), "--worker", "--manifest", manifestPath,
    "--split", values.split, "--samples", values.samples];
  if (values.workspace !== undefined) args.push("--workspace", path.resolve(values.workspace));
  if (values["candidate-report"] !== undefined) args.push("--candidate-report", path.resolve(values["candidate-report"]));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-bench-worker-"));
  let stdout: string;
  try {
    args.push("--temporary-root", temporary);
    ({ stdout } = await execute(process.execPath, args, {
      cwd: repository, timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
    }));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  const report = JSON.parse(stdout) as { status: string };
  if (values.output !== undefined) {
    await fs.writeFile(path.resolve(values.output), stdout, { flag: "wx" });
    process.stdout.write(`benchmark report: ${path.resolve(values.output)}\n`);
  } else {
    process.stdout.write(stdout);
  }
  if (report.status !== "completed") process.exitCode = 2;
}

await main().catch((error: unknown) => {
  process.stderr.write(`benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
