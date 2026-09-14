import { compute, formatRetry, pad, RetryTimer } from "./util.js";

export function run(width: number): string {
  const timer = new RetryTimer();
  const padded = pad("osnova", width);
  const computed = compute(timer.tick());
  return `${padded}:${computed}`;
}

export function describeRetry(): string {
  return formatRetry({ attempts: 2, backoffMs: 100 });
}

export function main(): void {
  console.log(run(8));
}
