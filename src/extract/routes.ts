import type { Callee, EdgeBinding, ReceiverOwner, RouteInfo } from "../types.js";

// A route is proved by four written facts: the receiver binds to an import from a listed framework
// package, the member is in that framework's verb set, the first argument is a plain string, and
// the handler is a bound name or a decorated definition. A verb name alone proves nothing.
export type RouteFramework = "express" | "nest" | "flask" | "fastapi";

interface FrameworkRule {
  readonly sources: readonly string[];
  readonly verbs: ReadonlySet<string>;
  readonly mounts: ReadonlySet<string>;
  readonly decorators?: ReadonlySet<string> | undefined;
}

const HTTP_VERBS = ["get", "post", "put", "delete", "patch", "options", "head"] as const;

const RULES: Readonly<Record<RouteFramework, FrameworkRule>> = {
  express: { sources: ["express"], verbs: new Set([...HTTP_VERBS, "all"]), mounts: new Set(["use"]) },
  nest: { sources: ["@nestjs/common"], verbs: new Set(), mounts: new Set(), decorators: new Set(["Get", "Post", "Put", "Delete", "Patch", "Options", "Head", "All", "Controller"]) },
  flask: { sources: ["flask"], verbs: new Set([...HTTP_VERBS, "route"]), mounts: new Set(["register_blueprint", "add_url_rule"]) },
  fastapi: { sources: ["fastapi"], verbs: new Set([...HTTP_VERBS, "api_route", "websocket"]), mounts: new Set(["include_router"]) },
};

const BY_SOURCE = new Map<string, RouteFramework>();
for (const [framework, rule] of Object.entries(RULES) as [RouteFramework, FrameworkRule][]) for (const source of rule.sources) BY_SOURCE.set(source, framework);

function sourceOfCallee(callee: Callee, depth: number): string | undefined {
  if (callee.kind === "import") return callee.source;
  if (callee.kind === "method") return sourceOfOwner(callee.owner, depth + 1);
  return undefined;
}

// The package the receiver ultimately comes from: `app = express()`, `router = express.Router()`,
// `app = Flask(__name__)` and `router = APIRouter()` all end at an import binding.
function sourceOfOwner(owner: ReceiverOwner, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  if (owner.kind === "import") return owner.source;
  if (owner.kind === "return") return sourceOfCallee(owner.of, depth + 1);
  return undefined;
}

export function frameworkOfReceiver(binding: EdgeBinding | undefined): RouteFramework | undefined {
  if (binding === undefined || binding.kind !== "member") return undefined;
  const source = sourceOfOwner(binding.owner);
  return source === undefined ? undefined : BY_SOURCE.get(source);
}

export function frameworkOfImport(binding: EdgeBinding | undefined): RouteFramework | undefined {
  return binding?.kind === "import" ? BY_SOURCE.get(binding.source) : undefined;
}

export function routeMethod(framework: RouteFramework, member: string): string | undefined {
  const rule = RULES[framework];
  if (rule.mounts.has(member)) return "ANY";
  if (!rule.verbs.has(member)) return undefined;
  return member === "route" || member === "all" || member === "api_route" ? "ANY" : member === "websocket" ? "WEBSOCKET" : member.toUpperCase();
}

export function decoratorMethod(framework: RouteFramework, name: string): string | undefined {
  if (RULES[framework].decorators?.has(name) !== true) return undefined;
  return name === "All" || name === "Controller" ? "ANY" : name.toUpperCase();
}

export function isMount(framework: RouteFramework, member: string): boolean {
  return RULES[framework].mounts.has(member);
}

// The edge store accepts paths up to this length; a longer literal is recorded as no path, never truncated.
export const MAX_ROUTE_PATH = 2048;

export function routeInfo(method: string, path: string | undefined): RouteInfo {
  return path === undefined || path.length > MAX_ROUTE_PATH ? { method } : { method, path };
}
