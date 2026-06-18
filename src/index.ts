/**
 * majordomo 程序化入口。库使用者可直接拿到 core 各模块。
 */
export { CoreDaemon } from "./core/daemon";
export { loadConfig, resolveProfile } from "./core/config";
export type { Config, Profile } from "./core/config";
export { SessionManager } from "./core/sessionManager";
export { Store } from "./core/store";
export * from "./protocol/messages";
