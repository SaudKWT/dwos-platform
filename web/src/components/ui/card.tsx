import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Card — the primary surface for grouping dashboard content.
 *
 * Uses `border-border` (decorative, quiet) rather than `border-input`. A card's
 * edge is a grouping cue, not a control affordance, so it is deliberately low
 * contrast — a 3:1 outline around every panel would turn a dense dashboard into
 * a grid of boxes.
 *
 * RESTYLED 2026-08-12 to the shadcn canonical shape, which is also what
 * shadcn-space's dashboard-shell-03 renders. Padding moved from each slot onto
 * the Card as `py-6` plus per-slot `px-6`, with a `gap-6` between slots. That is
 * what lets a card carry a header, a divider and a footer without every slot
 * re-declaring its own padding and fighting the one above it.
 *
 * IT MAKES CARDS TALLER. A header sitting directly on content gains 24px of gap.
 * That is the intended change and it is visible in any consuming app the moment
 * @koc/card is re-added — nothing errors, cards simply grow.
 *
 * WHAT WAS DELIBERATELY NOT COPIED FROM THE REFERENCE:
 *
 *   Its 14px description. That means moving --text-sm from 0.8125rem, which
 *   re-points a class used on every table cell and form label in every consuming
 *   app — the exact re-flow docs/consumer-reports/2026-08-12-dwos.md measured.
 *   Not worth one pixel on a card description.
 *
 *   Its borderless hairline (a ~10% ring, no border). Reproducing it means
 *   lightening --border to roughly neutral[100], which FAILS test:tokens against
 *   the 1.25:1 decorative floor, and collapses --border onto accent/secondary/
 *   muted — the same token collapse that broke the DWOS toggle in v0.1.4.
 *
 *   Its KPI tiles, which wash a whole card in 10%-alpha hue that does not track
 *   sentiment: -12% on green, +23% on red. That is decoratively the failure
 *   stat-card.tsx exists to prevent, and its bg-teal-400/10 is a raw palette
 *   colour, which is invariant 1 outright.
 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-lg border bg-card py-6 text-card-foreground shadow-xs",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-header"
      /* A grid, so CardAction can occupy a second column spanning both rows
         without the title and description having to know it is there. */
      className={cn(
        "grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6",
        "has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        "[.border-b]:pb-6",
        className,
      )}
      {...props}
    />
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-title"
      /* No `leading-tight`: KOC emits --text-lg with no paired line-height, so
         Tailwind's default survives and text-lg lands on exactly 28px, which is
         the reference's figure. And no `tracking-tight` — foundation.ts defines
         a letterSpacing scale that build.ts never emits, so it silently applied
         Tailwind's -0.025em rather than KOC's -0.015em. Removing it is honest
         until that scale actually ships. */
      className={cn("text-lg font-semibold", className)}
      {...props}
    />
  ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  ),
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-slot="card-content" className={cn("px-6", className)} {...props} />
  ),
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  ),
);
CardFooter.displayName = "CardFooter";

/**
 * CardAction — a control in the card's top-right, beside the title.
 *
 * New, and not cosmetic: any block copied from ui.shadcn.com today uses
 * `<CardAction>`, and without it those blocks do not compile against @koc/card.
 * It also replaces the pattern this repo had been hand-rolling —
 * `<CardHeader className="flex-row items-start justify-between space-y-0">` —
 * which is now inert, because CardHeader is a grid and `flex-row` does nothing
 * to it.
 */
const CardAction = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  ),
);
CardAction.displayName = "CardAction";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
};
