import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Label. Always pair with a control via htmlFor — an unassociated label is
 * invisible to assistive tech and kills the click-to-focus target for everyone.
 *
 * A native <label>. The Radix primitive this wrapped added only one behaviour
 * — suppressing text selection on double click — which `select-none` covers
 * without a dependency. (This file was the audit's blind spot: it imported
 * `@radix-ui/react-label` directly rather than the `radix-ui` umbrella the
 * exposure grep counted, so it never appeared in the 14.)
 */
const Label = React.forwardRef<
  HTMLLabelElement,
  React.ComponentPropsWithoutRef<"label">
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    data-slot="label"
    className={cn(
      "text-sm font-medium leading-none select-none",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className,
    )}
    {...props}
  />
));
Label.displayName = "Label";

export { Label };
