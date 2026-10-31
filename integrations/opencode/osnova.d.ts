export interface OsnovaPluginHooks {
  "chat.message": (input: { sessionID?: string }, output: { message: unknown; parts: Array<{ type: string; text?: string }> }) => Promise<void>;
  event: (input: { event: { type?: string; properties?: { sessionID?: string; info?: { id?: string; parentID?: string }; error?: { name?: string } } } }) => Promise<void>;
}
export interface OsnovaPluginClient {
  session?: { promptAsync?: (options: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }) => Promise<unknown> };
}
export declare const OsnovaPlugin: (input: { directory?: string; worktree?: string; client?: OsnovaPluginClient }) => Promise<OsnovaPluginHooks>;
export default OsnovaPlugin;
