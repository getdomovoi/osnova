#!/usr/bin/env node
import { writeSync } from "node:fs";
import os from "node:os";
import { runCli } from "./cli.js";
import { boundText } from "../query/budget.js";
import { cacheLockTimeoutIn, releaseHeldCacheLocksSync } from "../cache/lock.js";

function errorLine(error: unknown): string {
  const shown = cacheLockTimeoutIn(error) ?? error;
  const message = shown instanceof Error ? shown.message : String(shown);
  return boundText(`osnova: ${message.replace(/^osnova: /, "")}`) + "\n";
}

function exitNow(code: number, message?: string): never {
  releaseHeldCacheLocksSync();
  if (message !== undefined) {
    try { writeSync(process.stderr.fd, message); } catch { /* stderr is gone; the exit code still reports */ }
  }
  process.exit(code);
}

function installProcessHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => exitNow(128 + os.constants.signals[signal]));
  }
  const crash = (kind: string) => (reason: unknown): void => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    exitNow(2, boundText(`osnova: ${kind}: ${detail}`) + "\n");
  };
  process.on("unhandledRejection", crash("unhandled rejection"));
  process.on("uncaughtException", crash("uncaught exception"));
}

export async function main(): Promise<void> {
  try {
    const code = await runCli(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(errorLine(error));
    process.exitCode = 2;
  }
}

installProcessHandlers();
await main();
