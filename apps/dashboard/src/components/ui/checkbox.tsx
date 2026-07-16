import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "../../lib/utils";

export const Checkbox = forwardRef<ElementRef<typeof CheckboxPrimitive.Root>, ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root data-slot="checkbox" ref={ref} className={cn("peer size-4 shrink-0 cursor-pointer rounded-sm border border-[var(--input)] bg-white shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1 data-[state=checked]:border-[var(--accent)] data-[state=checked]:bg-[var(--accent)] data-[state=checked]:text-white disabled:cursor-not-allowed disabled:opacity-55", className)} {...props}>
    <CheckboxPrimitive.Indicator className="flex items-center justify-center"><Check className="size-3" /></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;
