import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="badge" className={cn("inline-flex w-fit items-center rounded-sm", className)} {...props} />;
}
