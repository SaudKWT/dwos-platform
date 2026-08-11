import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Badge — a small label for counts, tags and categories.
 *
 * For plant/asset state use `StatusBadge` instead: it forces an icon and a text
 * label, which this component does not.
 */
const badgeVariants = cva(
  [
    "inline-flex items-center gap-1 border",
    "text-2xs font-medium transition-colors duration-fast ease-out",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    "[&_svg]:size-3 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        success: "border-transparent bg-success text-success-foreground",
        warning: "border-transparent bg-warning text-warning-foreground",
        info: "border-transparent bg-info text-info-foreground",
        outline: "border-input text-foreground",
      },
      shape: {
        label: "rounded-sm px-2 py-0.5",
        /**
         * A count next to a label — tab counts, unread markers, nav badges.
         *
         * `min-w-5` with `h-5` rather than a fixed `size-5`: at one digit the
         * min-width and height are equal so it renders as a true circle, and at
         * three digits it grows into a pill instead of clipping the number or
         * squashing it into an ellipse. A hard-coded circle looks right until
         * the first count reaches 100, which on an operations dashboard is a
         * matter of time.
         *
         * The padding is `px-1`, not `px-1.5`: at 1.5 a single digit plus 12px
         * of padding measured 21px against a 20px height — one pixel out of
         * round, which is invisible in a spec and obvious on a 20px circle.
         * At `px-1` the min-width wins for one and two digits and the padding
         * only takes over at three.
         *
         * `tabular-nums` so a count ticking 8 → 9 → 10 does not jitter.
         */
        count: "h-5 min-w-5 justify-center rounded-full px-1 tabular-nums",
      },
    },
    defaultVariants: { variant: "default", shape: "label" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, shape, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant, shape }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
