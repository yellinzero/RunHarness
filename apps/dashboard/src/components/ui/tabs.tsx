import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../lib/utils";

export function Tabs(props: ComponentPropsWithoutRef<typeof TabsPrimitive.Root>) { return <TabsPrimitive.Root data-slot="tabs" {...props} />; }
export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(({ className, ...props }, ref) => <TabsPrimitive.List data-slot="tabs-list" ref={ref} className={cn("flex", className)} {...props} />);
TabsList.displayName = TabsPrimitive.List.displayName;
export const TabsTrigger = forwardRef<ElementRef<typeof TabsPrimitive.Trigger>, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(({ className, ...props }, ref) => <TabsPrimitive.Trigger data-slot="tabs-trigger" ref={ref} className={cn("inline-flex min-h-9 items-center justify-center px-3 text-sm data-[state=active]:font-semibold", className)} {...props} />);
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;
