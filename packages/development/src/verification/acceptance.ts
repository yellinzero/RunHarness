import type { AcceptanceSpec, EvidenceRecord } from "@runharness/shared";
import type { ExecutionRuntimeRegistry, RuntimeExecutionContext } from "../runtime/execution-runtime.js";

/** 按项目配置顺序执行确定性验收，并保留每项检查的原始证据。 */
export async function runAcceptance(
  specs: AcceptanceSpec[],
  runtimes: ExecutionRuntimeRegistry,
  context: RuntimeExecutionContext,
  onStart?: (spec: AcceptanceSpec) => void | Promise<void>,
): Promise<EvidenceRecord[]> {
  const evidence: EvidenceRecord[] = [];
  for (const spec of specs) {
    context.signal?.throwIfAborted();
    await onStart?.(spec);
    evidence.push(await runtimes.execute(spec, context));
  }
  return evidence;
}

/** 只有配置为 required 的验收项全部通过，才允许进入接受结果的生命周期分支。 */
export function requiredAcceptancePassed(evidence: EvidenceRecord[]): boolean {
  return evidence.filter((item) => item.source === "configured_acceptance" && item.requirement === "required").every((item) => item.status === "passed");
}
