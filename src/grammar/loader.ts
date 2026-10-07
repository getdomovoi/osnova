import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import type { LanguageId } from "../types.js";
import { grammarFile } from "./languages.js";

const require = createRequire(import.meta.url);

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function walkUpFind(packageName: string, relativeFile: string): string | undefined {
  let dir = moduleDir();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, "node_modules", packageName, relativeFile);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function resolvePackageFile(packageName: string, relativeFile: string): string {
  try {
    return require.resolve(`${packageName}/${relativeFile}`);
  } catch {
    const found = walkUpFind(packageName, relativeFile);
    if (found !== undefined) return found;
    throw new Error(
      `osnova: cannot locate ${packageName}/${relativeFile}; ensure the package is installed next to @getdomovoi/osnova`,
    );
  }
}

function packageFile(packageName: string, relativeFile: string): string {
  return resolvePackageFile(packageName, relativeFile);
}

let initPromise: Promise<void> | undefined;

// web-tree-sitter keeps one runtime per copy of the package and ignores init options once anyone, Osnova or its
// host, has called Parser.init, so Osnova cannot rely on an init hook.
async function ensureInit(): Promise<void> {
  initPromise ??= (async () => {
    const wasmPath = packageFile("web-tree-sitter", "tree-sitter.wasm");
    await Parser.init({ locateFile: () => wasmPath });
  })();
  return initPromise;
}

// Prebuilt grammars resolve their C library imports against the runtime's import table. The bash scanner
// imports `isalpha`, which this web-tree-sitter build does not export, so a parse that reaches a `case`
// pattern calls an unresolved stub and throws. Supply it with musl's C-locale definition.
const missingLibcImports: Readonly<Record<string, (c: number) => number>> = {
  isalpha: (c) => (((c | 32) - 97) >>> 0 < 26 ? 1 : 0),
};

// The ES2023 lib and Node's types declare no WebAssembly values; these are the parts grammar loading and the
// scanner state guard use.
type WasmFunction = (...args: number[]) => number;
type WasmImports = Readonly<Record<string, unknown>> & { readonly env: object };
interface WasmInstance {
  readonly exports: Record<string, unknown>;
}
interface WasmMemory {
  readonly buffer: ArrayBuffer;
}
interface WasmTable {
  get(index: number): unknown;
  grow(delta: number): number;
  set(index: number, value: unknown): void;
}
type WasmInstantiate = (bytes: unknown, imports?: WasmImports) => Promise<unknown>;
interface WasmRuntime {
  readonly Module: new (bytes: Uint8Array) => object;
  readonly Instance: new (module: object, imports: object) => WasmInstance;
  instantiate: WasmInstantiate;
}
const wasm = (globalThis as unknown as { readonly WebAssembly: WasmRuntime }).WebAssembly;

interface RuntimeHandles {
  readonly memory: WasmMemory;
  readonly table: WasmTable;
  readonly malloc: WasmFunction;
}

function captureRuntime(env: object): RuntimeHandles | undefined {
  const { memory, __indirect_function_table: table, malloc } = env as {
    readonly memory?: Partial<WasmMemory>;
    readonly __indirect_function_table?: Partial<WasmTable>;
    readonly malloc?: unknown;
  };
  if (!(memory?.buffer instanceof ArrayBuffer) || typeof table?.grow !== "function" || typeof malloc !== "function") return undefined;
  return { memory: memory as WasmMemory, table: table as WasmTable, malloc: malloc as WasmFunction };
}

function withLibcImports(env: object): object {
  return new Proxy(env, {
    get: (target, name, receiver) =>
      typeof name === "string" && Object.hasOwn(missingLibcImports, name) ? missingLibcImports[name] : Reflect.get(target, name, receiver),
  });
}

// Language.load instantiates a grammar as a side module whose `env` imports resolve against the live runtime,
// whoever initialized it. Observing that one instantiation yields the runtime's memory, function table and malloc
// and lets the missing C library imports in. The observer replaces WebAssembly.instantiate only while a load is
// pending and passes every other module through untouched; loads run one at a time so each restores the
// function it replaced.
let grammarLoads: Promise<unknown> = Promise.resolve();

function loadGrammar(wasmPath: string): Promise<{ readonly loaded: Language; readonly runtime: RuntimeHandles | undefined }> {
  const run = grammarLoads.then(async () => {
    const bytes = new Uint8Array(await readFile(wasmPath));
    let runtime: RuntimeHandles | undefined;
    const instantiate = wasm.instantiate;
    const observe: WasmInstantiate = (binary, imports) => {
      if (binary !== bytes || imports === undefined) return instantiate.call(wasm, binary, imports);
      runtime = captureRuntime(imports.env);
      return instantiate.call(wasm, binary, { ...imports, env: withLibcImports(imports.env) });
    };
    wasm.instantiate = observe;
    try {
      return { loaded: await Language.load(bytes), runtime };
    } finally {
      if (wasm.instantiate === observe) wasm.instantiate = instantiate;
    }
  });
  grammarLoads = run.catch(() => undefined);
  return run;
}

// The bash scanner serializes every pending heredoc into the parser's 1024-byte scanner state buffer and checks
// the bound a few bytes short. About 130 heredocs pending at once (a pipeline or list of `cat <<E` joined across
// lines) write past the buffer into the parser's stack pointer, which sits right after it. The parse still
// returns a tree, and later parses on any parser of the runtime report false syntax errors or fail with
// out-of-bounds memory errors. The parser calls serialize through the language's external scanner slot, so the
// guard points that slot at a trampoline that serializes into a scratch buffer four times the size, past the
// few bytes the scanner overruns, and copies back only a state that fits. A larger state becomes 0 bytes, the
// scanner's own answer for a state it cannot store. The trampoline adds one JS round trip per external bash token.
const guardedScannerLanguages: ReadonlySet<LanguageId> = new Set(["bash"]);
const SERIALIZATION_BUFFER_SIZE = 1024;
const SCRATCH_SIZE = 4 * SERIALIZATION_BUFFER_SIZE;
// TSLanguage (tree_sitter/parser.h) on wasm32: ABI 14 and 15 share the prefix through external_scanner.
const LANGUAGE_ABI_OFFSET = 0;
const LANGUAGE_EXTERNAL_TOKEN_COUNT_OFFSET = 16;
const SCANNER_SLOTS = [
  { offset: 112, arity: 0 },
  { offset: 116, arity: 1 },
  { offset: 120, arity: 3 },
  { offset: 124, arity: 2 },
  { offset: 128, arity: 3 },
] as const;
const SERIALIZE_SLOT = 3;
// A wasm module that exports its one import, an (i32, i32) -> i32 function, so the table can hold a JS function.
const reexportModule = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x02, 0x09, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
  0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
]);

function guardScannerState(language: LanguageId, loaded: Language, handles: RuntimeHandles | undefined): void {
  if (handles === undefined) throw new Error("osnova: the tree-sitter runtime exposes no memory, function table or malloc");
  const base = (loaded as unknown as { readonly 0: number })[0];
  const view = (): DataView => new DataView(handles.memory.buffer);
  const abi = view().getUint32(base + LANGUAGE_ABI_OFFSET, true);
  const externalTokens = view().getUint32(base + LANGUAGE_EXTERNAL_TOKEN_COUNT_OFFSET, true);
  const slots = SCANNER_SLOTS.map((slot) => handles.table.get(view().getUint32(base + slot.offset, true)));
  const matches = slots.every((fn, i) => typeof fn === "function" && fn.length === SCANNER_SLOTS[i]?.arity);
  if ((abi !== 14 && abi !== 15) || externalTokens === 0 || !matches) {
    throw new Error(`osnova: grammar "${language}" does not have the external scanner layout the scanner state guard expects`);
  }
  const serialize = slots[SERIALIZE_SLOT] as WasmFunction;
  const scratch = handles.malloc(SCRATCH_SIZE);
  if (scratch === 0) throw new Error(`osnova: cannot allocate the scanner state buffer for grammar "${language}"`);
  const trampoline = (payload: number, buffer: number): number => {
    const length = serialize(payload, scratch);
    if (length > SERIALIZATION_BUFFER_SIZE) return 0;
    new Uint8Array(handles.memory.buffer).copyWithin(buffer, scratch, scratch + length);
    return length;
  };
  const reexport = new wasm.Instance(new wasm.Module(reexportModule), { env: { f: trampoline } });
  const index = handles.table.grow(1);
  handles.table.set(index, reexport.exports.f);
  view().setUint32(base + SCANNER_SLOTS[SERIALIZE_SLOT].offset, index, true);
}

const languageCache = new Map<LanguageId, Promise<Language>>();
const parserCache = new Map<LanguageId, Promise<Parser>>();
const loadedLanguages = new Map<LanguageId, Language>();

export function loadedLanguage(language: LanguageId): Language {
  const loaded = loadedLanguages.get(language);
  if (loaded === undefined) throw new Error(`osnova: grammar "${language}" not loaded`);
  return loaded;
}

export async function loadLanguage(language: LanguageId): Promise<Language> {
  let pending = languageCache.get(language);
  if (pending === undefined) {
    pending = (async () => {
      await ensureInit();
      const wasmPath = packageFile("tree-sitter-wasms", path.join("out", grammarFile[language]));
      let loaded: Language;
      let runtime: RuntimeHandles | undefined;
      try {
        ({ loaded, runtime } = await loadGrammar(wasmPath));
      } catch (error) {
        throw new Error(
          `osnova: failed to load tree-sitter grammar "${language}" from ${wasmPath}. ` +
            "The prebuilt grammar WASM may use an ABI or dynamic-linking format that this " +
            "web-tree-sitter build cannot read. Fix by pinning web-tree-sitter to 0.25.x or " +
            "rebuilding the grammars with `tree-sitter build --wasm`. " +
            `Underlying error: ${String(error)}`,
          { cause: error },
        );
      }
      if (guardedScannerLanguages.has(language)) guardScannerState(language, loaded, runtime);
      loadedLanguages.set(language, loaded);
      return loaded;
    })();
    languageCache.set(language, pending);
    pending.catch(() => {
      languageCache.delete(language);
    });
  }
  return pending;
}

export async function getParser(language: LanguageId): Promise<Parser> {
  let pending = parserCache.get(language);
  if (pending === undefined) {
    pending = (async () => {
      const lang = await loadLanguage(language);
      const parser = new Parser();
      parser.setLanguage(lang);
      return parser;
    })();
    parserCache.set(language, pending);
    pending.catch(() => {
      parserCache.delete(language);
    });
  }
  return pending;
}

export function discardParser(language: LanguageId): void {
  const pending = parserCache.get(language);
  if (pending === undefined) return;
  parserCache.delete(language);
  // A parser is discarded after a parse failed, often because the wasm runtime aborted mid-parse. Freeing
  // its memory can then throw as well; a throw inside this handler would surface as an unhandled rejection
  // and end the process. The caller already reports the failure, so leaking the broken parser is the
  // safer outcome.
  void pending.then(
    (parser) => {
      try {
        parser.delete();
      } catch {
        return;
      }
    },
    () => undefined,
  );
}

export async function probeGrammars(): Promise<void> {
  await getParser("typescript");
}
