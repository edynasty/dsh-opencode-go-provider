/**
 * Bilingual Connect card copy, following the DSH client locale convention
 * (a plain `en` dictionary plus a `zh` mirror typed by its keys).
 */

/** English copy for the OpenCode Go Connect card. */
export const en = {
  title: "OpenCode Go",
  intro: "Connect your OpenCode Go API key.",
  keyLabel: "API key",
  keyPlaceholder: "sk-…",
  keyHelp: "The key is stored through DSH credentials and is never shown again.",
  connected: "Connected",
  notConnected: "Not connected",
  connect: "Connect",
  testConnection: "Test connection",
  disconnect: "Disconnect",
  loading: "Loading…",
  invalidKey: "The provided key was refused before storing.",
  storeFailed: "The credential could not be stored.",
  statusUnavailable: "The status could not be loaded.",
  testResultPrefix: "Live /models reports ",
  testUnconfigured: "No credential configured; connect first.",
  testUnavailable: "No usable live endpoint in the current catalog.",
  testFailed: "Connection test failed.",
} as const;

/** Keys shared by both dictionaries. */
export type ConnectCardKey = keyof typeof en;

/** Chinese copy for the OpenCode Go Connect card. */
export const zh: { [Key in ConnectCardKey]: string } = {
  title: "OpenCode Go",
  intro: "连接你的 OpenCode Go API Key。",
  keyLabel: "API Key",
  keyPlaceholder: "sk-…",
  keyHelp: "密钥仅通过 DSH 凭据存储，不会再次显示。",
  connected: "已连接",
  notConnected: "未连接",
  connect: "连接",
  testConnection: "测试连接",
  disconnect: "断开",
  loading: "加载中…",
  invalidKey: "提供的密钥在存储前被拒绝。",
  storeFailed: "凭据无法存储。",
  statusUnavailable: "无法加载状态。",
  testResultPrefix: "Live /models 报告 ",
  testUnconfigured: "尚未配置凭据，请先连接。",
  testUnavailable: "当前目录中没有可用的实时端点。",
  testFailed: "连接测试失败。",
};
