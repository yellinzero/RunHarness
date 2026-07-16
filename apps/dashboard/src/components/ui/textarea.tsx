import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea data-slot="textarea" ref={ref} className={cn("min-h-28 w-full resize-y rounded-sm border border-[var(--input)] bg-white p-3 text-sm", className)} {...props} />
));
Textarea.displayName = "Textarea";
