/**
 * 可插拔通知器（人设层的"副作用动作"）。
 * 本地实现：弹窗 / 提示音（PowerShell）、控制台。未来：推手机（ntfy/Bark/Telegram）。
 */
export interface Notifier {
  readonly name: string;
  /** 发出一次交接提醒。message 为双语交接报告。 */
  notify(message: string): void | Promise<void>;
}
