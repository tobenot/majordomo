declare module "@anthropic-ai/claude-code" {
  export type SDKMessage = any;
  export function query(args: any): AsyncIterable<SDKMessage>;
}
