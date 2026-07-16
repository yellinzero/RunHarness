export type FailureCategory = "authentication" | "network" | "permission" | "dependency" | "context_size" | "provider_capability" | "provider_protocol" | "acceptance" | "review" | "unknown";

export interface StructuredFailure {
  category: FailureCategory;
  recoverable: boolean;
  nextAction: string;
}

/**
 * 把 Provider 的原始错误归入少量稳定类别，仅用于展示恢复建议。
 * 原始错误仍由事件存储保留，分类结果不能覆盖或美化真实失败原因。
 */
export function classifyFailure(message: string): StructuredFailure {
  const value = message.toLowerCase();
  if (/not authenticated|unauthorized|forbidden|401|403|api key|login/.test(value)) return { category: "authentication", recoverable: true, nextAction: "Authenticate the configured Agent, then submit the next Run in this Session." };
  if (/enotfound|eai_again|econnrefused|etimedout|network is unreachable|could not resolve|registry/.test(value)) return { category: "network", recoverable: true, nextAction: "Check the configured proxy and registry, then retry in this Session." };
  if (/eacces|eperm|permission denied|sandbox/.test(value)) return { category: "permission", recoverable: true, nextAction: "Inspect the workspace or network permission boundary, then retry with the minimum required access." };
  if (/lockfile|peer dep|eresolve|dependency|package manager/.test(value)) return { category: "dependency", recoverable: true, nextAction: "Use the repository package manager and resolve the recorded dependency error." };
  if (/input.*too (large|long)|maximum length|context window|context.*length/.test(value)) return { category: "context_size", recoverable: true, nextAction: "Use the Runtime Memory references and inspect evidence files instead of expanding the full history." };
  if (/does not support image|capabilit|unsupported.*attachment/.test(value)) return { category: "provider_capability", recoverable: true, nextAction: "Route this Run to an Agent/model with the required capability." };
  if (/could not parse|no json object|actionable plan|structured output/.test(value)) return { category: "provider_protocol", recoverable: true, nextAction: "RunHarness tried the configured fallback Agents; inspect their protocol errors or change the stage route before continuing this Session." };
  return { category: "unknown", recoverable: true, nextAction: "Inspect the recorded evidence and continue with corrective context in this Session." };
}
