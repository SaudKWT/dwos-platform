"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * FilterTabs — a segmented control that filters a view, with counts.
 *
 * The composition it replaces was eight lines of Tabs + TabsTrigger + Badge,
 * written by hand. That is not much code, and reuse is the weaker half of the
 * argument for having it.
 *
 * THE REAL REASON IT IS A COMPONENT
 * ---------------------------------
 * A `Tabs` with no `TabsContent` is an accessibility defect that looks like
 * working code. Radix wires `aria-controls` from every trigger to its panel; with
 * no panel the attribute points at an id that does not exist, so a screen reader
 * announces a tab controlling nothing. axe rates it critical, and it was the
 * first thing the a11y harness found when it was written — in this repo, in a
 * component someone had already reviewed.
 *
 * It is an easy mistake precisely because the visible result is correct. The
 * tabs look right, they switch, and nothing in the browser complains. So the
 * component takes `renderPanel` rather than children: there is no way to
 * construct a FilterTabs whose triggers point at nothing, in the same way
 * `ConfirmDialog` takes a required `subject` so nobody ships "Delete Item?".
 *
 * WHY COUNTS ARE PART OF IT
 * -------------------------
 * A filter without volume makes you click each option to find out where the work
 * is, and an empty option is indistinguishable from a full one until you land on
 * it. Showing the count means an empty filter is visibly empty rather than a
 * disappointment. `0` renders as `0` — never hidden, since the absence of a
 * badge would read as "unknown" rather than "none".
 */

export interface FilterTabsOption<T extends string = string> {
  value: T;
  label: string;
  /** Items behind this filter. Omit only when genuinely unknown, not for zero. */
  count?: number;
}

export interface FilterTabsProps<T extends string = string> {
  options: FilterTabsOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * Accessible name for the tab list, e.g. "Filter by asset".
   *
   * Required: a screen reader announcing "tab list, North, selected" gives no
   * clue what is being filtered, and a screen may carry more than one of these.
   */
  label: string;
  /** The panel for a given option. One is rendered per option — see above. */
  renderPanel: (value: T) => React.ReactNode;
  className?: string;
}

export function FilterTabs<T extends string = string>({
  options,
  value,
  onChange,
  label,
  renderPanel,
  className,
}: FilterTabsProps<T>) {
  return (
    <Tabs
      value={value}
      onValueChange={(v) => onChange(v as T)}
      className={className}
    >
      <TabsList aria-label={label} className="mb-3">
        {options.map((o) => (
          <TabsTrigger key={o.value} value={o.value} className="gap-1.5">
            {o.label}
            {o.count !== undefined && (
              /* NOT aria-hidden. The badge is the only place the number
                 appears, so hiding it would drop the count from the trigger's
                 accessible name and a screen-reader user would lose exactly the
                 information the badge exists to give. It announces "North 3",
                 which is what a sighted user sees. */
              <Badge variant="secondary" shape="count">
                {o.count}
              </Badge>
            )}
          </TabsTrigger>
        ))}
      </TabsList>

      {options.map((o) => (
        <TabsContent key={o.value} value={o.value}>
          {renderPanel(o.value)}
        </TabsContent>
      ))}
    </Tabs>
  );
}
