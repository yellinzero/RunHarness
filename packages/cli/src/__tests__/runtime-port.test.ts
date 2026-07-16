import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RUNTIME_PORT, startWithRuntimePort } from "../runtime/port.js";

describe("Runtime port selection", () => {
  it("uses 8888 as the preferred local Runtime port", () => {
    expect(DEFAULT_RUNTIME_PORT).toBe(8888);
  });

  it("falls back to an ephemeral port when the implicit default is occupied", async () => {
    const start = vi.fn(async (port: number) => {
      if (port === DEFAULT_RUNTIME_PORT) throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" });
      return port;
    });
    await expect(startWithRuntimePort(start, DEFAULT_RUNTIME_PORT, true)).resolves.toBe(0);
    expect(start.mock.calls).toEqual([[8888], [0]]);
  });

  it("keeps an explicit port strict and reports how to choose another", async () => {
    const start = vi.fn(async () => { throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" }); });
    await expect(startWithRuntimePort(start, 4400, false)).rejects.toThrow("Port 4400 is already in use. Choose another with --port PORT.");
    expect(start).toHaveBeenCalledTimes(1);
  });
});
