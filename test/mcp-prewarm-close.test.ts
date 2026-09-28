import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Holds the warm-up at its first await so close can land while it is running, as it would on a large repository.
const gate = vi.hoisted(() => ({ release: undefined as (() => void) | undefined, warmTask: vi.fn() }));
vi.mock("../src/query/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/query/context.js")>();
  return {
    ...actual,
    warmQueryContext: async (index: Parameters<typeof actual.warmQueryContext>[0], options: Parameters<typeof actual.warmQueryContext>[1]) => {
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return actual.warmQueryContext(index, options);
    },
  };
});
vi.mock("../src/query/task-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/query/task-context.js")>();
  return { ...actual, warmTaskContext: gate.warmTask };
});

import { createOsnovaMcpServer } from "../src/mcp/server.js";

const temporaries: string[] = [];
afterEach(async () => { for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true }); gate.warmTask.mockClear(); });

it("does not finish a warm-up that close interrupted", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-prewarm-close-"));
  temporaries.push(temporary);
  const workspace = path.join(temporary, "ws");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\n");
  const server = createOsnovaMcpServer(workspace, { cacheDir: path.join(temporary, "cache"), prewarm: true });
  await server.refresh();
  expect(server.status().warm).toBe("warming");
  server.close();
  gate.release?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(gate.warmTask).not.toHaveBeenCalled();
  expect(server.status().warm).toBe("closed");
});
