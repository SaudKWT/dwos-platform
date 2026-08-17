import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Button.
 *
 * Every variant's label/background pair is asserted in the token contrast tests,
 * so none of these combinations can regress below WCAG AA without failing CI.
 *
 * The focus ring is deliberately loud (2px, offset 2px, brand blue). It is the
 * only affordance a keyboard user has; if it ever looks "too strong" in a review,
 * that is the ring working.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-md text-sm font-medium",
    "transition-colors duration-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    // Disabled controls are exempt from contrast requirements, but they must
    // still be obviously inert — hence both the fade and the cursor change.
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        /** The KOC blue. White label measures 6.47:1 on it. */
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 active:bg-primary/95",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        /** Uses `border-input`, not `border-border`: an outline button's edge is
         *  what identifies it as a control, so it is held to 1.4.11's 3:1. */
        outline:
          "border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 rounded px-3 text-xs",
        default: "h-9 px-4 py-2",
        lg: "h-10 rounded-md px-6 text-md",
        /** Square. Must carry an aria-label — an icon alone is not a name. */
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as another element instead of a <button>, keeping the styling.
   *  Use for links that should look like buttons — preserves correct
   *  semantics: `<Button render={<a href=… />}>label</Button>`. */
  render?: useRender.RenderProp;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, render, ...props }, ref) => {
    // No mergeProps needed: className is folded into the variants above and
    // the defaults carry no event handlers; useRender itself merges the
    // render element's own props (className included).
    return useRender({
      defaultTagName: "button",
      render,
      ref,
      props: {
        "data-slot": "button",
        className: cn(buttonVariants({ variant, size, className })),
        ...props,
      },
    });
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
