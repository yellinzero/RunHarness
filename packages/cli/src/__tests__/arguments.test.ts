import { describe, expect, it } from "vitest";
import { parseRunOptions } from "../commands/arguments.js";

describe("CLI arguments", () => {
  it("parses print, web, placement, and a multi-word goal", () => {
    expect(parseRunOptions(["-p", "--web", "--port", "4400", "--max-iterations", "7", "--placement", "isolated", "fix", "tests"])).toEqual({
      goal: "fix tests",
      placement: "isolated",
      print: true,
      web: true,
      port: 4400,
      maxIterations: 7,
    });
  });

  it("rejects unknown options and invalid placements", () => {
    expect(() => parseRunOptions(["--unknown"])).toThrow("Unknown option");
    expect(() => parseRunOptions(["--placement", "unsafe"])).toThrow("Placement must be");
    expect(() => parseRunOptions(["--max-iterations", "0"])).toThrow("Iterations must be");
    expect(() => parseRunOptions(["--max-iterations", "many"])).toThrow("Iterations must be");
    expect(() => parseRunOptions(["--port", "0"])).toThrow("Port must be");
    expect(() => parseRunOptions(["--port", "many"])).toThrow("Port must be");
  });
});
