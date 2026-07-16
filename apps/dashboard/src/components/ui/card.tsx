import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => <div data-slot="card" ref={ref} className={cn("min-w-0 rounded-sm bg-[var(--card)] text-[var(--card-foreground)]", className)} {...props} />);
Card.displayName = "Card";
export const CardArticle = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(({ className, ...props }, ref) => <article data-slot="card" ref={ref} className={cn("min-w-0 rounded-sm bg-[var(--card)] text-[var(--card-foreground)]", className)} {...props} />);
CardArticle.displayName = "CardArticle";
export const CardHeader = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(({ className, ...props }, ref) => <header data-slot="card-header" ref={ref} className={cn(className)} {...props} />);
CardHeader.displayName = "CardHeader";
export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => <div data-slot="card-content" ref={ref} className={cn(className)} {...props} />);
CardContent.displayName = "CardContent";
