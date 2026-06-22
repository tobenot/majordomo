/**
 * Hook/plugin system type definitions.
 *
 * Hooks fire on lifecycle events and are configured per-project.
 * This is the contract: HookRunner, builtins, and user scripts all depend on these types.
 */

export interface Hook {
  readonly name: string;
  run(context: HookContext): void | Promise<void>;
}

export type HookEventType =
  | "after_task"          // after worker turn + persona report
  | "on_session_create"   // when a session is created/resumed
  | "on_session_close"    // when a session is closed
  | "on_error";           // when an error occurs

export interface HookContext {
  eventType: HookEventType;
  sessionId: string;
  sessionName: string;
  cwd: string;
  profile: string;
  engine?: string;
  text: string;
  timestamp: string;
  sessionCreatedAt?: number;
  /** after_task only: raw worker output */
  workerText?: string;
  /** after_task only: original user input */
  userText?: string;
}

// ── Hook config discriminated union ──

export interface DiaryHookConfig {
  type: "diary";
}

export interface NotifyHookConfig {
  type: "notify";
}

export interface ShellHookConfig {
  type: "shell";
  command: string;
  cwd?: string;         // default: projectRoot
  shell?: string;       // default: cmd (win) / sh (posix)
  timeoutMs?: number;   // default: 30000
}

export interface MarkdownReportHookConfig {
  type: "markdown_report";
  output_dir?: string;  // default: ".majordomo/reports"
}

export type HookConfig =
  | DiaryHookConfig
  | NotifyHookConfig
  | ShellHookConfig
  | MarkdownReportHookConfig;

export interface HooksConfig {
  after_task?: HookConfig[];
  on_session_create?: HookConfig[];
  on_session_close?: HookConfig[];
  on_error?: HookConfig[];
}
