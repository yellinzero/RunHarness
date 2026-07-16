import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, type = "text", ...props }, ref) => (
  <input data-slot="input" ref={ref} type={type} className={cn("min-h-10 w-full rounded-sm border border-[var(--input)] bg-white px-3 text-sm", className)} {...props} />
));
Input.displayName = "Input";
