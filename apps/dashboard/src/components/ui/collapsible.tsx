import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cn } from "../../lib/utils";

export const Collapsible = forwardRef<ElementRef<typeof CollapsiblePrimitive.Root>, ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>>(({ className, open, defaultOpen, ...props }, ref) => (
  <CollapsiblePrimitive.Root
    data-slot="collapsible"
    ref={ref}
    {...(open !== undefined ? { open } : defaultOpen !== undefined ? { defaultOpen } : {})}
    className={cn(className)}
    {...props}
  />
));
Collapsible.displayName = CollapsiblePrimitive.Root.displayName;
export const CollapsibleTrigger = forwardRef<ElementRef<typeof CollapsiblePrimitive.Trigger>, ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>>(({ className, ...props }, ref) => <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" ref={ref} className={cn(className)} {...props} />);
CollapsibleTrigger.displayName = CollapsiblePrimitive.Trigger.displayName;
export const CollapsibleContent = forwardRef<ElementRef<typeof CollapsiblePrimitive.Content>, ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>>(({ className, ...props }, ref) => <CollapsiblePrimitive.Content data-slot="collapsible-content" ref={ref} className={cn(className)} {...props} />);
CollapsibleContent.displayName = CollapsiblePrimitive.Content.displayName;
