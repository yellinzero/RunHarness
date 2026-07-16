import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectTrigger = forwardRef<ElementRef<typeof SelectPrimitive.Trigger>, ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>>(({ className, children, ...props }, ref) => <SelectPrimitive.Trigger data-slot="select-trigger" ref={ref} className={cn("flex h-10 min-w-0 w-full items-center justify-between gap-2 overflow-hidden rounded-sm border border-[var(--input)] bg-white px-3 text-sm", className)} {...props}>{children}<SelectPrimitive.Icon className="shrink-0"><ChevronDown className="size-4 opacity-60" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>);
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;
export const SelectContent = forwardRef<ElementRef<typeof SelectPrimitive.Content>, ComponentPropsWithoutRef<typeof SelectPrimitive.Content>>(({ className, children, position = "popper", ...props }, ref) => <SelectPrimitive.Portal><SelectPrimitive.Content data-slot="select-content" ref={ref} position={position} sideOffset={4} className={cn("z-50 max-h-80 min-w-[8rem] overflow-hidden rounded-sm border border-[var(--border)] bg-white p-1 shadow-lg", className)} {...props}><SelectPrimitive.Viewport data-slot="select-viewport">{children}</SelectPrimitive.Viewport></SelectPrimitive.Content></SelectPrimitive.Portal>);
SelectContent.displayName = SelectPrimitive.Content.displayName;
export const SelectItem = forwardRef<ElementRef<typeof SelectPrimitive.Item>, ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(({ className, children, ...props }, ref) => <SelectPrimitive.Item data-slot="select-item" ref={ref} className={cn("relative flex cursor-default select-none items-center rounded-sm py-2 pl-8 pr-2 text-sm outline-none data-[highlighted]:bg-[var(--secondary)]", className)} {...props}><span className="absolute left-2"><SelectPrimitive.ItemIndicator><Check className="size-4" /></SelectPrimitive.ItemIndicator></span><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText></SelectPrimitive.Item>);
SelectItem.displayName = SelectPrimitive.Item.displayName;
