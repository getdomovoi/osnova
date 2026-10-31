export interface OsnovaGatePluginHooks {
  "chat.message": (input: { sessionID?: string }) => Promise<void>;
  "tool.execute.before": (input: { tool: string; sessionID?: string }, output: { args?: Record<string, unknown> }) => Promise<void>;
}
export declare const OsnovaGatePlugin: (input: { directory?: string; worktree?: string }) => Promise<OsnovaGatePluginHooks>;
export default OsnovaGatePlugin;
