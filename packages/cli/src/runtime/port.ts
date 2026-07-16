export const DEFAULT_RUNTIME_PORT = 8888;

/** 启动项目 Runtime；交互入口可退回系统空闲端口，显式指定端口时则原样报告占用错误。 */
export async function startWithRuntimePort<T>(start: (port: number) => Promise<T>, port: number, allowFallback: boolean): Promise<T> {
  try {
    return await start(port);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    if (!allowFallback) throw new Error(`Port ${port} is already in use. Choose another with --port PORT.`, { cause: error });
    return start(0);
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
}
