export interface OsnovaPluginHooks {
  "chat.message": (input: unknown, output: { message: unknown; parts: Array<{ type: string; text?: string }> }) => Promise<void>;
}
export declare const OsnovaPlugin: (input: { directory?: string; worktree?: string }) => Promise<OsnovaPluginHooks>;
export default OsnovaPlugin;
