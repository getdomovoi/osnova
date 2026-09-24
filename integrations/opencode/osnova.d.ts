export interface OsnovaPluginHooks {
  "experimental.chat.system.transform": (input: unknown, output: { system: string[] }) => Promise<void>;
  "chat.message": (input: unknown, output: { message: unknown; parts: Array<{ type: string; text?: string }> }) => Promise<void>;
  "tool.execute.before": (input: { tool: string; sessionID?: string }, output: { args: Record<string, unknown> }) => Promise<void>;
}
export declare const OsnovaPlugin: (input: { directory?: string; worktree?: string }) => Promise<OsnovaPluginHooks>;
export default OsnovaPlugin;
