import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
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

// Prebuilt grammars resolve their C library imports against the runtime's import table. The bash scanner
// imports `isalpha`, which this web-tree-sitter build does not export, so a parse that reaches a `case`
// pattern calls an unresolved stub and throws. Supply it with musl's C-locale definition.
const missingLibcImports: Readonly<Record<string, (c: number) => number>> = {
  isalpha: (c) => (((c | 32) - 97) >>> 0 < 26 ? 1 : 0),
};

// The ES2023 lib and Node's types declare no WebAssembly values; these are the two constructors init uses.
interface WasmImports {
  readonly env: Record<string, unknown>;
}
interface WasmRuntime {
  readonly Module: new (bytes: Uint8Array) => object;
  readonly Instance: new (module: object, imports: WasmImports) => object;
}
const wasm = (globalThis as unknown as { readonly WebAssembly: WasmRuntime }).WebAssembly;

async function ensureInit(): Promise<void> {
  initPromise ??= (async () => {
    const wasmPath = packageFile("web-tree-sitter", "tree-sitter.wasm");
    await Parser.init({
      locateFile: () => wasmPath,
      // Compiled synchronously so a failure throws inside the runtime's promise executor and rejects init.
      instantiateWasm(imports: WasmImports, receive: (instance: object, module: object) => void) {
        Object.assign(imports.env, missingLibcImports);
        const module = new wasm.Module(readFileSync(wasmPath));
        receive(new wasm.Instance(module, imports), module);
        return {};
      },
    });
  })();
  return initPromise;
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
      try {
        const loaded = await Language.load(wasmPath);
        loadedLanguages.set(language, loaded);
        return loaded;
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
  void pending.then(
    (parser) => {
      parser.delete();
    },
    () => undefined,
  );
}

export async function probeGrammars(): Promise<void> {
  await getParser("typescript");
}
