"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * The active value, republished on our own context.
 *
 * Radix keeps the value in a context only ITS components consume. When the value
 * changes React re-renders `TabsPrimitive.Trigger` — not the wrapper around it,
 * whose props are unchanged and which consumes nothing. A layout effect inside
 * our own `TabsList` or `TabsTrigger` therefore never re-runs.
 *
 * That is what defeated four earlier attempts at the sliding indicator: it
 * measured correctly on mount and never again, and no amount of
 * MutationObserver, rAF coalescing or callback-ref work fixed it, because the
 * component holding the state was simply not re-rendering. Publishing the value
 * ourselves makes `TabsList` a real consumer.
 *
 * Radix stays the source of truth; this only mirrors it.
 */
const TabsValueContext = React.createContext<string | undefined>(undefined);

function Tabs({
  className,
  orientation = "horizontal",
  value,
  defaultValue,
  onValueChange,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const current = value ?? uncontrolled;

  const handleValueChange = React.useCallback(
    (next: string) => {
      if (value === undefined) setUncontrolled(next);
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  return (
    <TabsValueContext.Provider value={current}>
      <TabsPrimitive.Root
        data-slot="tabs"
        data-orientation={orientation}
        orientation={orientation}
        value={value}
        defaultValue={defaultValue}
        onValueChange={handleValueChange}
        className={cn(
          "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
          className,
        )}
        {...props}
      />
    </TabsValueContext.Provider>
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
  const value = React.useContext(TabsValueContext);
  const ref = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  // Keyed on `value`, which now genuinely changes — see TabsValueContext.
  React.useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-state="active"]');
    if (!active) return;
    setBox({
      left: active.offsetLeft,
      top: active.offsetTop,
      width: active.offsetWidth,
      height: active.offsetHeight,
    });
  }, [value]);

  // Suppress the transition until the first box lands, or every tab set slides
  // in from the origin on mount — a page glitch, not a transition.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    if (box) setReady(true);
  }, [box]);

  return (
    <TabsPrimitive.List
      ref={ref}
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
       * `left-0 top-0` is load-bearing. An absolutely positioned box with no
       * inset uses its STATIC position as the origin — for the first child of a
       * centred flex row that is mid-list, so the translate would offset from
       * the wrong point and the pill would land beside the tab instead of on it.
       *
       * Position and size are inline styles because they are measured pixels,
       * not design decisions; the token layer has nothing to say about how wide
       * the word "History" is.
       *
       * prefers-reduced-motion needs nothing here — the base layer collapses
       * transition-duration globally, so it still moves, it just arrives.
       */}
      {variant === "default" && box && (
        <span
          aria-hidden
          data-slot="tabs-indicator"
          className={cn(
            // Concentric radius, not a fixed step. The list is rounded-lg (12px) with
            // 3px of padding, so an inner corner only looks parallel to the outer
            // one at 12 - 3 = 9px. rounded-md (8px) is close enough to pass unnoticed
            // and wrong enough to read as pinched corners.
            "absolute left-0 top-0 rounded-[calc(var(--radius-lg)-3px)] bg-background shadow-sm",
            "transition-[transform,width,height] duration-slow ease-spring",
            !ready && "transition-none",
          )}
          style={{
            transform: `translate(${box.left}px, ${box.top}px)`,
            width: box.width,
            height: box.height,
          }}
        />
      )}
      {children}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
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
        "data-[state=active]:text-foreground",
        // `line` variant keeps its underline and gets no sliding pill.
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity after:duration-fast group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
