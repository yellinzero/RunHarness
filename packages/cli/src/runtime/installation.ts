import { fileURLToPath } from "node:url";

/** Dashboard 静态资源与安装后的 CLI bundle 放在同一发布目录。 */
export function installedDashboardDir(): string {
  return fileURLToPath(new URL("./dashboard", import.meta.url));
}
