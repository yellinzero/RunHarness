import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { cn } from "../../lib/utils";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogPortal = AlertDialogPrimitive.Portal;
export const AlertDialogCancel = forwardRef<ElementRef<typeof AlertDialogPrimitive.Cancel>, ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>>(({ className, ...props }, ref) => <AlertDialogPrimitive.Cancel ref={ref} className={cn("inline-flex min-h-9 items-center justify-center rounded-sm border border-[var(--border)] px-3 text-sm font-semibold", className)} {...props} />);
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName;
export const AlertDialogAction = forwardRef<ElementRef<typeof AlertDialogPrimitive.Action>, ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>>(({ className, ...props }, ref) => <AlertDialogPrimitive.Action ref={ref} className={cn("inline-flex min-h-9 items-center justify-center rounded-sm bg-[var(--destructive)] px-3 text-sm font-semibold text-white", className)} {...props} />);
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName;
export const AlertDialogContent = forwardRef<ElementRef<typeof AlertDialogPrimitive.Content>, ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>>(({ className, ...props }, ref) => <AlertDialogPortal><AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45" /><AlertDialogPrimitive.Content ref={ref} className={cn("fixed left-1/2 top-1/2 z-50 grid w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-sm border border-[var(--border)] bg-white p-6 shadow-xl", className)} {...props} /></AlertDialogPortal>);
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName;
export const AlertDialogHeader = ({ className, ...props }: ComponentPropsWithoutRef<"div">) => <div className={cn("grid gap-2", className)} {...props} />;
export const AlertDialogFooter = ({ className, ...props }: ComponentPropsWithoutRef<"div">) => <div className={cn("flex justify-end gap-2", className)} {...props} />;
export const AlertDialogTitle = AlertDialogPrimitive.Title;
export const AlertDialogDescription = AlertDialogPrimitive.Description;
