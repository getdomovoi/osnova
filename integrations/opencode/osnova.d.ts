export interface OsnovaPluginHooks {
  "experimental.chat.system.transform": (input: unknown, output: { system: string[] }) => Promise<void>;
  "chat.message": (input: { sessionID?: string }, output: { message: { system?: string | undefined }; parts: Array<{ type: string; text?: string }> }) => Promise<void>;
  "tool.execute.before": (input: { sessionID: string; tool: string; callID?: string | undefined }, output: { args: Record<string, unknown> }) => Promise<void>;
  "tool.execute.after": (input: { sessionID: string; tool: string; callID?: string | undefined; args?: Record<string, unknown> | undefined }, output: { output?: string | undefined; content?: unknown; isError?: boolean | undefined }) => Promise<void>;
}
export declare const OsnovaPlugin: (input: { directory?: string; worktree?: string }) => Promise<OsnovaPluginHooks>;
export default OsnovaPlugin;
