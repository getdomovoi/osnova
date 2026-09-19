import { OSNOVA_VERSION } from "../version.js";

export interface UpdateCheckResult {
  readonly name: string;
  readonly current: string;
  readonly latest: string;
  readonly outdated: boolean;
}

export interface UpdateCheckOptions {
  readonly current?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export const updateCheckRegistryUrl = "https://registry.npmjs.org/@getdomovoi/osnova/latest";

const packageName = "@getdomovoi/osnova";
const defaultTimeoutMs = 5000;

function releaseParts(version: string): readonly number[] {
  const release = version.split("-", 1)[0] ?? "";
  return release.split(".").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isNaN(value) ? 0 : value;
  });
}

/** True when `latest` is a strictly newer release than `current`. A prerelease sorts below its release. */
export function isNewerVersion(latest: string, current: string): boolean {
  const left = releaseParts(latest);
  const right = releaseParts(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  const leftPre = latest.includes("-");
  const rightPre = current.includes("-");
  if (leftPre === rightPre) return false;
  return rightPre;
}

/**
 * Ask the npm registry for the latest published version. This is the only part of osnova that
 * opens a network connection, and it runs only when a person types `osnova update-check`.
 */
export async function updateCheck(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const current = options.current ?? OSNOVA_VERSION;
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await request(updateCheckRegistryUrl, { signal: controller.signal, headers: { accept: "application/json" } });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`osnova update-check could not reach the npm registry: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`osnova update-check: the npm registry answered ${response.status}`);
  const body: unknown = await response.json();
  const latest = typeof body === "object" && body !== null ? (body as { version?: unknown }).version : undefined;
  if (typeof latest !== "string" || latest.length === 0) throw new Error("osnova update-check: the npm registry answer has no version field");
  return { name: packageName, current, latest, outdated: isNewerVersion(latest, current) };
}

export function formatUpdateCheck(result: UpdateCheckResult): string {
  if (result.outdated) return `${result.name} ${result.current} is behind ${result.latest}\nupdate with: npm install -g ${result.name}@${result.latest}`;
  return `${result.name} ${result.current} is up to date`;
}
