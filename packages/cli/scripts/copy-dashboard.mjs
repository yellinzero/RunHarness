import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("../../apps/dashboard/dist");
const target = path.resolve("dist/dashboard");
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
