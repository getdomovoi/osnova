#!/usr/bin/env node
import { runCli } from "./cli.js";
import { boundText } from "../query/budget.js";

export async function main(): Promise<void> {
  try {
    const code = await runCli(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(boundText(`osnova: ${error instanceof Error ? error.message : String(error)}`) + "\n");
    process.exitCode = 2;
  }
}

await main();
