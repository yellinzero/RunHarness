import type { BuiltinPermissionCatalogEntry, ExecutionPolicy, PermissionAction, PermissionDecision, PermissionRule } from "@runharness/shared";

export interface McpToolAnnotations {
  destructiveHint?: boolean;
  readOnlyHint?: boolean;
  openWorldHint?: boolean;
}

export const builtinPermissionCatalog: BuiltinPermissionCatalogEntry[] = [
  { id: "destructive_changes", decision: "ask", examples: ["rm -rf", "git push", "git reset --hard", "git clean -f", "kubectl apply/delete", "terraform apply/destroy", "pnpm publish", "deploy"] },
  { id: "credential_access", decision: "ask", examples: ["security find", "keychain", ".env", "credentials", "secret", "token", ".ssh", ".aws", ".config/gcloud", "Library/Keychains"] },
  { id: "external_network", decision: "ask", examples: ["https://api.example.com"] },
  { id: "mcp_side_effects", decision: "ask", examples: ["destructiveHint", "openWorldHint + write", "interactive browser action"] },
  { id: "reversible_development", decision: "allow", examples: ["edit project files", "run tests", "localhost browser validation", "read-only MCP tools"] },
];

export function evaluatePermission(policy: ExecutionPolicy, action: PermissionAction): PermissionDecision {
  const matched = mostRestrictiveMatch(policy.customRules, action);
  if (matched) return { decision: matched.decision, source: "custom_rule", reason: matched.description || `Matched ${matched.scope} rule '${matched.pattern}'`, ruleId: matched.id };
  if (policy.approvalMode === "allow_all") return allow("RunHarness adds no approval prompt for actions not matched by a project rule");
  return dangerousDecision(action);
}

function mostRestrictiveMatch(rules: PermissionRule[], action: PermissionAction): PermissionRule | undefined {
  const priority = { allow: 0, ask: 1, deny: 2 } as const;
  return rules.filter((rule) => matchesRule(rule, action)).sort((left, right) => priority[right.decision] - priority[left.decision])[0];
}

export function mcpPermissionAction(
  exposedName: string,
  input: Record<string, unknown>,
  annotations?: McpToolAnnotations,
): PermissionAction {
  const match = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(exposedName);
  const server = match?.[1] ?? "unknown";
  const tool = match?.[2] ?? exposedName;
  const origin = findOrigin(input);
  const summary = `${server}/${tool}${origin ? ` → ${origin}` : ""}`;
  const action: PermissionAction = { kind: "mcp", summary, server, tool, input, ...(origin ? { origin } : {}) };
  if (annotations?.destructiveHint) action.summary = `${summary} (destructive)`;
  else if (annotations?.readOnlyHint === true) action.summary = `${summary} (read only)`;
  else if (annotations?.openWorldHint) action.summary = `${summary} (external)`;
  return action;
}

export function providerToolPermissionAction(toolCall: {
  title?: string | null;
  kind?: string | null | undefined;
  rawInput?: unknown;
  locations?: Array<{ path: string }> | null | undefined;
}): PermissionAction {
  const input = toolCall.rawInput && typeof toolCall.rawInput === "object" && !Array.isArray(toolCall.rawInput)
    ? toolCall.rawInput as Record<string, unknown>
    : {};
  const command = stringField(input, ["command", "cmd"]);
  const filePath = stringField(input, ["path", "file_path", "filePath"]) ?? toolCall.locations?.[0]?.path;
  const tool = stringField(input, ["tool", "tool_name", "toolName"]);
  const server = stringField(input, ["server", "server_name", "serverName"]);
  const origin = findOrigin(input);
  const kind = toolCall.kind === "execute" ? command?.trimStart().startsWith("git ") ? "git" : "command"
    : toolCall.kind === "read" || toolCall.kind === "edit" || toolCall.kind === "delete" || toolCall.kind === "move" ? "file"
      : tool || server ? "mcp"
        : origin ? "network"
          : "other";
  return {
    kind,
    summary: toolCall.title ?? command ?? tool ?? "Provider tool action",
    ...(command ? { command } : {}),
    ...(filePath ? { path: filePath } : {}),
    ...(origin ? { origin } : {}),
    ...(server ? { server } : {}),
    ...(tool ? { tool } : {}),
    ...(Object.keys(input).length ? { input } : {}),
  };
}

export function permissionAllowRule(action: PermissionAction): PermissionRule {
  if (action.kind === "mcp" && action.server && action.tool)
    return permissionRule("mcp_tool", `${action.server}/${action.tool}`, action.summary);
  if (action.command) return permissionRule("command", action.command, action.summary);
  if (action.origin) return permissionRule("origin", action.origin, action.summary);
  if (action.path) return permissionRule("path", action.path, action.summary);
  return permissionRule("action", action.kind, action.summary);
}

export function mcpAnnotationDecision(action: PermissionAction, annotations?: McpToolAnnotations): PermissionDecision | undefined {
  if (annotations?.destructiveHint) return ask("MCP marks this tool as destructive", "destructive");
  if (isLocalOrigin(action.origin)) return undefined;
  if (annotations?.openWorldHint && !isReadOnlyTool(action.tool)) return ask("This MCP action can affect an external system", "external_write");
  if (annotations?.readOnlyHint === true || isReadOnlyTool(action.tool)) return undefined;
  if (isInteractiveBrowserTool(action.tool)) return ask("Browser interaction can change external state", "external_write");
  return undefined;
}

function dangerousDecision(action: PermissionAction): PermissionDecision {
  if (action.kind === "command" || action.kind === "git" || action.kind === "deployment") {
    const value = `${action.command ?? ""} ${action.summary}`;
    if (/\b(?:rm\s+-[^\n]*r[^\n]*f|git\s+(?:push|reset\s+--hard|clean\s+-[^\n]*f)|kubectl\s+(?:apply|delete)|terraform\s+(?:apply|destroy)|(?:npm|pnpm|yarn)\s+publish|deploy)\b/i.test(value))
      return ask("The command can make a destructive, remote, or production change", "destructive");
    if (/\b(?:security\s+find|keychain|\.env|credentials|secret|token)\b/i.test(value))
      return ask("The command may access credentials or secrets", "credentials");
  }
  if (action.kind === "file" && action.path && /(?:^|\/)(?:\.ssh|\.aws|\.config\/gcloud|Library\/Keychains)(?:\/|$)/.test(action.path))
    return ask("The target path may contain credentials", "credentials");
  if (action.kind === "network" && action.origin && !isLocalOrigin(action.origin))
    return ask("The action communicates with an external origin", "external_write");
  if (action.kind === "mcp") return allow("The MCP action is not classified as dangerous by built-in rules");
  return allow("The action is a normal reversible development operation");
}

function matchesRule(rule: PermissionRule, action: PermissionAction): boolean {
  const value = rule.scope === "command" ? action.command
    : rule.scope === "path" ? action.path
      : rule.scope === "origin" ? action.origin
        : rule.scope === "mcp_tool" ? [action.server, action.tool].filter(Boolean).join("/")
          : action.kind;
  return Boolean(value && globMatch(value, rule.pattern));
}

function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function findOrigin(input: Record<string, unknown>): string | undefined {
  for (const key of ["url", "origin", "href"]) {
    const value = input[key];
    if (typeof value !== "string") continue;
    try { return new URL(value).origin; }
    catch { /* 不是绝对 URL 时继续按普通文本规则判断。 */ }
  }
  return undefined;
}

function stringField(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof input[key] === "string" && input[key]) return input[key];
  return undefined;
}

function permissionRule(scope: PermissionRule["scope"], pattern: string, summary: string): PermissionRule {
  return {
    id: `approval_${Buffer.from(`${scope}:${pattern}`).toString("base64url").slice(0, 24)}`,
    scope,
    pattern,
    decision: "allow",
    description: `Approved action: ${summary}`,
  };
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch { return false; }
}

function isReadOnlyTool(tool: string | undefined): boolean {
  return Boolean(tool && /(?:snapshot|screenshot|console|network|list|read|get|inspect|query|search)/i.test(tool));
}

function isInteractiveBrowserTool(tool: string | undefined): boolean {
  return Boolean(tool && /(?:click|type|fill|press|upload|download|submit|evaluate|run_code)/i.test(tool));
}

function allow(reason: string): PermissionDecision { return { decision: "allow", source: "builtin", reason }; }
function ask(reason: string, category: NonNullable<PermissionDecision["category"]>): PermissionDecision { return { decision: "ask", source: "builtin", reason, category }; }
