import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Alert — an inline message.
 *
 * Callers must supply an icon. As with StatusBadge, colour alone cannot carry
 * the severity (WCAG 1.4.1), and a tinted rectangle with no icon is exactly the
 * shape that failure takes.
 *
 * Use `role="alert"` only for messages that appear *in response to* something the
 * user did — it interrupts a screen reader mid-sentence. Static page-level notes
 * should keep the default role.
 */
const alertVariants = cva(
  [
    "relative w-full rounded-md border p-4",
    "grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-start",
    "[&>svg]:size-4 [&>svg]:mt-0.5 [&>svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground border-border",
        info: "border-info/30 bg-info/8 text-foreground [&>svg]:text-info",
        success: "border-success/30 bg-success/8 text-foreground [&>svg]:text-success",
        warning: "border-warning/30 bg-warning/8 text-foreground [&>svg]:text-warning",
        destructive:
          "border-destructive/40 bg-destructive/8 text-foreground [&>svg]:text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  ),
);
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5
      ref={ref}
      className={cn("col-start-2 font-medium leading-none tracking-tight", className)}
      {...props}
    />
  ),
);
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("col-start-2 text-sm text-muted-foreground [&_p]:leading-relaxed", className)}
    {...props}
  />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription, alertVariants };
