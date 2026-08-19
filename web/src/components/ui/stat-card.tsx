import * as React from "react";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

/**
 * StatCard — a single KPI: label, value, unit, and change over a period.
 *
 * ── The `intent` prop, and why it exists ──────────────────────────────────────
 *
 * Nearly every stat card ever written colours the delta green when the arrow
 * points up. That is a bug wearing a convention's clothing, and it is an actively
 * dangerous one at an oil company:
 *
 *   Production up 4%   → good
 *   Gas flared up 4%   → bad, and reportable
 *   Emissions up 4%    → bad
 *   Downtime up 4%     → bad
 *   Water cut up 4%    → bad
 *
 * A component that infers sentiment from direction gets *half* of a KOC dashboard
 * backwards, and it does so silently and confidently — a green arrow next to
 * rising flare volume tells an operator the opposite of the truth.
 *
 * So direction and sentiment are separate inputs here. `delta` carries the
 * arithmetic (which way it moved); `intent` carries the meaning (whether that is
 * good). Direction is derived and cannot be wrong. Sentiment must be declared by
 * the caller, because only the caller knows what the metric *is*.
 *
 * `intent="higher-is-better"` is NOT the default — `"neutral"` is. An unthinking
 * StatCard renders an honest grey delta rather than a confident wrong colour.
 */
export type StatIntent =
  /** Up is good, down is bad. Production, uptime, recovery factor. */
  | "higher-is-better"
  /** Down is good, up is bad. Flaring, emissions, downtime, water cut, cost. */
  | "lower-is-better"
  /** No inherent sentiment — the delta renders grey. The default. */
  | "neutral";

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  /** The value. Pre-formatted by the caller — this component will not guess at
   *  locale, precision or unit conventions for a plant measurement. */
  value: string | number;
  unit?: string;
  /** Signed change. Sign gives direction; `intent` gives meaning. */
  delta?: number;
  /** How to format the delta. */
  deltaFormat?: "percent" | "absolute";
  /** What the delta is measured against, e.g. "vs last month". */
  deltaLabel?: string;
  /** Whether a rise is good, bad, or neither. Defaults to "neutral" on purpose. */
  intent?: StatIntent;
  icon?: React.ReactNode;
}

/** Direction is arithmetic. Sentiment is editorial. Only the first is derivable. */
function sentimentOf(delta: number, intent: StatIntent): "good" | "bad" | "flat" {
  if (delta === 0 || intent === "neutral") return "flat";
  const rising = delta > 0;
  if (intent === "higher-is-better") return rising ? "good" : "bad";
  return rising ? "bad" : "good"; // lower-is-better
}

const SENTIMENT_CLASS: Record<"good" | "bad" | "flat", string> = {
  good: "text-success",
  bad: "text-destructive",
  flat: "text-muted-foreground",
};

const StatCard = React.forwardRef<HTMLDivElement, StatCardProps>(
  (
    {
      label,
      value,
      unit,
      delta,
      deltaFormat = "percent",
      deltaLabel,
      intent = "neutral",
      icon,
      className,
      ...props
    },
    ref,
  ) => {
    const hasDelta = typeof delta === "number";
    const sentiment = hasDelta ? sentimentOf(delta, intent) : "flat";
    const Arrow = !hasDelta || delta === 0 ? ArrowRight : delta > 0 ? ArrowUp : ArrowDown;

    const deltaText = hasDelta
      ? deltaFormat === "percent"
        ? `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`
        : `${delta > 0 ? "+" : ""}${delta.toLocaleString()}`
      : null;

    // `gap-0` is load-bearing. Card now sets `flex flex-col gap-6`, and a
    // StatCard's label / value / delta rows are DIRECT children of it — without
    // this each would gain 24px of separation and the tile would triple in
    // height. `p-5` overrides Card's `py-6` through twMerge; the gap does not
    // resolve that way and has to be said explicitly.
    return (
      <Card ref={ref} data-slot="stat-card" className={cn("gap-0 p-5", className)} {...props}>
        <div className="flex items-start justify-between gap-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          {icon && <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>}
        </div>

        <div className="mt-2 flex items-baseline gap-1.5">
          {/* data-slot drives tabular-nums from the base layer, so a column of
              these aligns on the decimal instead of shimmying digit by digit. */}
          <span
            data-slot="kpi-value"
            className="text-3xl font-semibold leading-tight tracking-tight"
          >
            {value}
          </span>
          {unit && <span className="text-sm font-medium text-muted-foreground">{unit}</span>}
        </div>

        {hasDelta && (
          <div className="mt-2 flex items-center gap-1.5 text-xs">
            <span className={cn("inline-flex items-center gap-0.5 font-medium", SENTIMENT_CLASS[sentiment])}>
              <Arrow className="size-3" aria-hidden="true" />
              <span data-slot="kpi-value">{deltaText}</span>
            </span>
            {deltaLabel && <span className="text-muted-foreground">{deltaLabel}</span>}
            {/* The arrow and colour are visual; this is what a screen reader gets.
                "increase"/"decrease" is stated in words so the direction does not
                depend on perceiving an icon. */}
            <span className="sr-only">
              {delta === 0
                ? "no change"
                : `${delta > 0 ? "increase" : "decrease"}${
                    sentiment !== "flat" ? `, ${sentiment === "good" ? "favourable" : "unfavourable"}` : ""
                  }`}
              {deltaLabel ? ` ${deltaLabel}` : ""}
            </span>
          </div>
        )}
      </Card>
    );
  },
);
StatCard.displayName = "StatCard";

export { StatCard };
