import { promises as fs } from "node:fs";
import { percentile } from "./metrics.js";

export interface ProcMemory {
  rssKiB: number | null;
  hwmKiB: number | null;
  threads: number | null;
}

export interface SampleSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  samples: number[];
}

export interface PayloadShape {
  codeUnits: number;
  bytes: number;
  lines: number;
  clipped: boolean;
  clippedCodeUnits: number | null;
  reportsOmissions: boolean;
}

function statusField(text: string, name: string): number | null {
  const match = new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function parseProcStatus(text: string): ProcMemory {
  return { rssKiB: statusField(text, "VmRSS"), hwmKiB: statusField(text, "VmHWM"), threads: statusField(text, "Threads") };
}

// Linux only: other platforms, and a process that already exited, report null fields.
export async function readProcMemory(pid: number): Promise<ProcMemory> {
  try {
    return parseProcStatus(await fs.readFile(`/proc/${pid}/status`, "utf8"));
  } catch {
    return { rssKiB: null, hwmKiB: null, threads: null };
  }
}

// Writing 5 to clear_refs resets VmHWM to the current VmRSS (Linux 4.0 and later), so a later VmHWM
// read is the peak since this call rather than since process start.
export async function resetPeakMemory(pid: number): Promise<boolean> {
  try {
    await fs.writeFile(`/proc/${pid}/clear_refs`, "5");
    return true;
  } catch {
    return false;
  }
}

export async function childPids(pid: number): Promise<number[]> {
  try {
    const tasks = await fs.readdir(`/proc/${pid}/task`);
    const children = await Promise.all(tasks.map((task) => fs.readFile(`/proc/${pid}/task/${task}/children`, "utf8").catch(() => "")));
    return children.flatMap((text) => text.split(/\s+/).filter(Boolean).map(Number)).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function describeSamples(samples: readonly number[]): SampleSummary {
  if (samples.length === 0) return { count: 0, p50: null, p95: null, min: null, max: null, mean: null, samples: [] };
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    samples: [...samples],
  };
}

export function payloadShape(text: string): PayloadShape {
  const clipped = /\[output truncated: (\d+) UTF-16 code units omitted/.exec(text);
  return {
    codeUnits: text.length,
    bytes: Buffer.byteLength(text),
    lines: text.split("\n").length,
    clipped: clipped !== null,
    clippedCodeUnits: clipped?.[1] === undefined ? null : Number(clipped[1]),
    reportsOmissions: /^\s*omitted:/m.test(text),
  };
}
