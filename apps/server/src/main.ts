import { startServer } from "./index.js";

const app = await startServer();
let closing = false;
// 多个退出信号可能连续到达；关闭锁保证端口、SSE 和 Runtime 注册只清理一次。
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void close().finally(() => process.exit(0)); });
