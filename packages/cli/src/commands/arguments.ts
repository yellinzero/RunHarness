import { validateMaxIterations, type WorkspacePlacement } from "@runharness/shared";

export interface RunOptions {
  goal: string;
  placement?: WorkspacePlacement;
  print: boolean;
  web: boolean;
  port?: number;
  maxIterations?: number;
}

export function parseRunOptions(values: string[]): RunOptions {
  const goal: string[] = [];
  let placement: RunOptions["placement"];
  let print = false;
  let web = false;
  let port: number | undefined;
  let maxIterations: number | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "-p" || value === "--print") print = true;
    else if (value === "--web" || value === "-w") web = true;
    else if (value === "--port") {
      port = parsePort(values[index + 1]);
      index += 1;
    }
    else if (value === "--max-iterations") {
      maxIterations = validateMaxIterations(values[index + 1]);
      index += 1;
    } else if (value === "--placement") {
      const selected = values[index + 1];
      if (selected !== "in_place" && selected !== "isolated") throw new Error("Placement must be in_place or isolated");
      placement = selected;
      index += 1;
    } else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else goal.push(value);
  }
  return { goal: goal.join(" "), print, web, ...(placement ? { placement } : {}), ...(port ? { port } : {}), ...(maxIterations ? { maxIterations } : {}) };
}

function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port must be an integer between 1 and 65535");
  return port;
}
