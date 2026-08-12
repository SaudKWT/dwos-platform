import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Input.
 *
 * `border-input` is the token that carries KOC's WCAG 1.4.11 compliance —
 * measured 3.63:1 against the page and 3.96:1 on a card. Do not "soften" this to
 * `border-border` to make forms look lighter: that border is the only thing
 * telling a user the field exists, and dropping it to 1.6:1 makes the form
 * invisible to low-vision users while looking fine to everyone reviewing it.
 */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        data-slot="input"
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1",
          "text-sm shadow-xs transition-colors",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // Error state is driven by aria-invalid rather than a prop, so the
          // visual and the assistive-tech announcement can never disagree.
          "aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
