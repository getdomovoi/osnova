export const MAX_RETRIES = 3;

export interface RetryOptions {
  readonly attempts: number;
  readonly backoffMs: number;
}

export class RetryTimer {
  private ticks = 0;

  tick(): number {
    this.ticks += 1;
    return this.ticks;
  }
}

export function pad(input: string, width: number): string {
  if (input.length >= width) return input;
  return input + " ".repeat(width - input.length);
}

export function formatRetry(options: RetryOptions): string {
  return `retrying up to ${options.attempts} times every ${options.backoffMs}ms`;
}

function internalHelper(value: number): number {
  return value * MAX_RETRIES;
}

export function compute(value: number): number {
  return internalHelper(value) + 1;
}
