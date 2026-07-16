import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { enterTerminalScreen } from "../terminal/screen.js";

describe("terminal screen guard", () => {
  it("enters the alternate screen and restores it exactly once", () => {
    const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
    Object.assign(output, { isTTY: true });
    let written = "";
    output.on("data", (chunk) => { written += chunk.toString(); });
    const guard = enterTerminalScreen(output);
    guard.restore();
    guard.restore();
    expect(written).toBe("\u001B[?1049h\u001B[2J\u001B[H\u001B[0m\u001B[?2004l\u001B[<u\u001B[>4;0m\u001B[?1049l\u001B[?25h");
  });

  it("does not write terminal controls for piped output", () => {
    const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
    Object.assign(output, { isTTY: false });
    let written = "";
    output.on("data", (chunk) => { written += chunk.toString(); });
    enterTerminalScreen(output).restore();
    expect(written).toBe("");
  });
});
