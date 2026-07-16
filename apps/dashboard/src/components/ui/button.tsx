import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva("inline-flex min-h-9 items-center justify-center gap-2 rounded-sm border border-transparent px-3 py-2 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50", {
  variants: {
    variant: {
      default: "bg-[var(--primary)] text-[var(--primary-foreground)] hover:brightness-110",
      secondary: "bg-[var(--secondary)] text-[var(--secondary-foreground)]",
      destructive: "bg-[var(--destructive)] text-[var(--destructive-foreground)]",
      ghost: "bg-transparent text-inherit hover:bg-black/5",
      outline: "border-[var(--border)] bg-transparent text-[var(--foreground)]",
      nav: "bg-transparent text-inherit",
      tab: "bg-transparent text-inherit",
    },
    size: { default: "min-h-9 px-3", sm: "min-h-8 px-2 text-xs", icon: "size-9 p-0" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = "button", ...props }, ref) => <button data-slot="button" ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />);
Button.displayName = "Button";
