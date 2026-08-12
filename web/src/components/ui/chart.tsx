"use client";

import * as React from "react";
import {
  Area,
  AreaChart as RcAreaChart,
  Bar,
  BarChart as RcBarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart as RcLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cn } from "@/lib/utils";

/**
 * Chart wrappers — the boilerplate, the brand and the bug fix, in one place.
 *
 * A Recharts line chart is about fifty lines of axis, grid, tooltip and legend
 * configuration before it draws anything. Forty KOC apps writing that by hand
 * produces forty subtly different charts, and three specific failures that are
 * expensive to find later:
 *
 * 1. THE STRICTMODE BUG. Under React 19 StrictMode, Recharts' mount tween never
 *    advances past frame zero and every line renders with correct geometry,
 *    correct stroke, opacity 1 and ZERO PIXELS DRAWN. Confirmed still present in
 *    recharts 3.8. `isAnimationActive={false}` is not configurable here — a prop
 *    that can be forgotten is a prop that will be.
 *
 * 2. SERIES COLOUR CHOSEN BY HAND. `--chart-1..5` are not an arbitrary palette:
 *    each adjacent pair is asserted at ΔE2000 ≥ 15 *and* ≥ 1.2:1 in greyscale
 *    luminance, so the series stay distinguishable when printed or read by
 *    someone with achromatopsia. Picking colours per-chart throws that away
 *    silently. Series here take their colour from the tokens, in order.
 *
 * 3. NO TEXT ALTERNATIVE. A chart is an image to a screen reader. These render
 *    a visually-hidden summary and an optional data table, so the numbers are
 *    reachable without sight — the single most-skipped part of dashboard a11y.
 */

export interface ChartSeries {
  /** Key into each data row. */
  key: string;
  /** Human label, used in the legend, tooltip and text alternative. */
  label: string;
  /** Override the token colour. Use sparingly — see note 2 above. */
  color?: string;
}

export interface ChartProps<T extends Record<string, unknown>> {
  data: T[];
  /** Key for the category axis — usually a date or an asset name. */
  xKey: string;
  series: ChartSeries[];
  height?: number;
  /**
   * What the chart shows, in a sentence. Required: it becomes the accessible
   * name, and "chart" is not a description.
   */
  caption: string;
  /** Format axis and tooltip values, e.g. thousands separators or units. */
  valueFormat?: (value: number) => string;
  /** Render the underlying numbers as a table beneath the chart. */
  showTable?: boolean;
  className?: string;
}

/** Series colour by position, from the tested token ramp. */
function seriesColor(s: ChartSeries, i: number): string {
  return s.color ?? `var(--chart-${(i % 5) + 1})`;
}

const AXIS = {
  stroke: "var(--muted-foreground)",
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;

/**
 * Screen-reader alternative.
 *
 * Recharts renders SVG with no meaningful structure, so a chart is silence
 * without this. The summary states the shape; the optional table carries the
 * actual figures.
 */
function TextAlternative<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  caption,
  valueFormat,
  visible,
}: {
  data: T[];
  xKey: string;
  series: ChartSeries[];
  caption: string;
  valueFormat?: (v: number) => string;
  visible: boolean;
}) {
  const fmt = valueFormat ?? ((v: number) => String(v));
  return (
    <table className={cn(visible ? "mt-4 w-full text-sm" : "sr-only")}>
      <caption className={cn(visible ? "pb-2 text-left text-sm text-muted-foreground" : "sr-only")}>
        {caption}
      </caption>
      <thead>
        <tr>
          <th scope="col" className={cn(visible && "border-b border-border py-1.5 text-left")}>
            {xKey}
          </th>
          {series.map((s) => (
            <th
              key={s.key}
              scope="col"
              className={cn(visible && "border-b border-border py-1.5 text-right")}
            >
              {s.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i}>
            <th scope="row" className={cn(visible && "py-1.5 text-left font-normal")}>
              {String(row[xKey])}
            </th>
            {series.map((s) => (
              <td key={s.key} className={cn(visible && "py-1.5 text-right tabular-nums")}>
                {fmt(Number(row[s.key]))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function useTooltipStyle() {
  return React.useMemo(
    () => ({
      contentStyle: {
        background: "var(--popover)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        fontSize: 12,
        color: "var(--popover-foreground)",
      },
      labelStyle: { color: "var(--muted-foreground)" },
    }),
    [],
  );
}

/** Trend over time. The default for anything with a date on the x axis. */
export function TrendChart<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  height = 280,
  caption,
  valueFormat,
  showTable = false,
  className,
}: ChartProps<T>) {
  const tip = useTooltipStyle();

  return (
    <figure className={cn("w-full", className)}>
      {/*
       * `inert` as well as `aria-hidden`, not instead of it.
       *
       * Recharts renders focusable elements inside its SVG, and aria-hidden on a
       * container holding them is a serious violation in its own right — a
       * keyboard user can land on something no screen reader can describe. axe
       * flagged exactly this on first run. `inert` removes the subtree from the
       * tab order too, which is correct here because the text alternative below
       * carries the content in full.
       */}
      <div aria-hidden inert style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RcLineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey={xKey} {...AXIS} />
            <YAxis {...AXIS} tickFormatter={valueFormat} />
            <Tooltip {...tip} formatter={valueFormat as never} />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {series.map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={seriesColor(s, i)}
                strokeWidth={2}
                dot={false}
                // NOT a prop. See note 1 in the file header — under React 19
                // StrictMode this is the difference between a chart and an
                // empty box.
                isAnimationActive={false}
              />
            ))}
          </RcLineChart>
        </ResponsiveContainer>
      </div>

      <TextAlternative
        data={data}
        xKey={xKey}
        series={series}
        caption={caption}
        valueFormat={valueFormat}
        visible={showTable}
      />
    </figure>
  );
}

/** Comparison across categories — wells, rigs, units. */
export function ComparisonChart<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  height = 280,
  caption,
  valueFormat,
  showTable = false,
  className,
}: ChartProps<T>) {
  const tip = useTooltipStyle();

  return (
    <figure className={cn("w-full", className)}>
      <div aria-hidden inert style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RcBarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey={xKey} {...AXIS} />
            <YAxis {...AXIS} tickFormatter={valueFormat} />
            <Tooltip {...tip} formatter={valueFormat as never} cursor={{ fill: "var(--muted)" }} />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={seriesColor(s, i)}
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            ))}
          </RcBarChart>
        </ResponsiveContainer>
      </div>

      <TextAlternative
        data={data}
        xKey={xKey}
        series={series}
        caption={caption}
        valueFormat={valueFormat}
        visible={showTable}
      />
    </figure>
  );
}

/** Cumulative or volume-over-time. Same rules as TrendChart. */
export function VolumeChart<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  height = 280,
  caption,
  valueFormat,
  showTable = false,
  className,
}: ChartProps<T>) {
  const tip = useTooltipStyle();

  return (
    <figure className={cn("w-full", className)}>
      <div aria-hidden inert style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RcAreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey={xKey} {...AXIS} />
            <YAxis {...AXIS} tickFormatter={valueFormat} />
            <Tooltip {...tip} formatter={valueFormat as never} />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {series.map((s, i) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={seriesColor(s, i)}
                fill={seriesColor(s, i)}
                fillOpacity={0.15}
                strokeWidth={2}
                isAnimationActive={false}
              />
            ))}
          </RcAreaChart>
        </ResponsiveContainer>
      </div>

      <TextAlternative
        data={data}
        xKey={xKey}
        series={series}
        caption={caption}
        valueFormat={valueFormat}
        visible={showTable}
      />
    </figure>
  );
}
