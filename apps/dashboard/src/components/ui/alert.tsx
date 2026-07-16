import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Alert({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="alert" role="alert" className={cn("rounded-sm", className)} {...props} />;
}
