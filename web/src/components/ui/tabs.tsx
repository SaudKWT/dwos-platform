"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "@/lib/utils";

/**
 * Built on Base UI. The sliding indicator is Base's own `Tabs.Indicator`,
 * positioned entirely from its live inline variables
 * (`--active-tab-left/-top/-width/-height`).
 *
 * HISTORY, so nobody re-adds what this deleted: under Radix the active value
 * lived in a context only Radix's components consumed, so a wrapper never
 * re-rendered and a measuring layout effect ran once and never again. Four
 * indicator attempts failed that way, and the fix was a `TabsValueContext`
 * that republished the value plus a measure-and-suppress-first-transition
 * dance (~60 lines). Base UI ships the measured position as CSS variables on
 * the Indicator part, so the entire mechanism is now four utility classes.
 * The behaviour is still asserted, not assumed — tests/tabs.spec.ts checks
 * tracking, on-scale motion, overshoot containment and corner concentricity.
 */

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list relative inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {/*
       * `ease-spring` — cubic-bezier(0.34, 1.2, 0.64, 1) — is the overshoot
       * curve foundation.ts describes as "for elements that should feel
       * physical". A tab indicator is exactly that: a real object moving to a
       * new position, not a colour fading in. The control point is 1.2 rather
       * than the conventional 1.56 because an indicator sliding inside a
       * container has nowhere to put a 9.8% overshoot — see foundation.ts.
       *
       * Concentric radius, not a fixed step: the list is rounded-lg (12px)
       * with 3px of padding, so the inner corner is 12 - 3 = 9px.
       *
       * `left-0 top-0` is load-bearing: the translate offsets from the static
       * position, which for a mid-list child would not be the list's corner.
       *
       * prefers-reduced-motion needs nothing here — the base layer collapses
       * transition-duration globally, so it still moves, it just arrives.
       */}
      {variant === "default" && (
        <TabsPrimitive.Indicator
          aria-hidden
          data-slot="tabs-indicator"
          className={cn(
            "absolute left-0 top-0 rounded-[calc(var(--radius-lg)-3px)] bg-background shadow-sm",
            "w-(--active-tab-width) h-(--active-tab-height)",
            "translate-x-(--active-tab-left) translate-y-(--active-tab-top)",
            "transition-[translate,width,height] duration-slow ease-spring",
          )}
        />
      )}
      {children}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        // `h-full`, not shadcn's `h-[calc(100%-1px)]`. That 1px leaves the
        // trigger 29px inside a 30px content box, and `items-center` splits the
        // remainder unevenly — measured 4px above the indicator and 3px below,
        // against 3px of padding on every side. Filling the box makes all four
        // insets equal.
        //
        // `relative z-10` so the label sits above the sliding indicator.
        "relative z-10 inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-[calc(var(--radius-lg)-3px)] border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-colors duration-fast ease-out group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // The active background is the indicator's job now — a trigger that
        // paints its own background cannot slide.
        "data-active:text-foreground",
        // `line` variant keeps its underline and gets no sliding pill.
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity after:duration-fast group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
