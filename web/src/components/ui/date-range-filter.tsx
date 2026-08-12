"use client";

import * as React from "react";
import {
  addDays,
  addMonths,
  endOfMonth,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
} from "date-fns";
import { CalendarIcon, ChevronDown } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * DateRangeFilter — compact trigger, calendar and grouped presets side by side.
 *
 * Combines two shadcn-space calendars, taking the better half of each:
 *
 *   calendar-16  the compact trigger and the horizontal popover — calendar on
 *                one side, controls on the other, both visible at once.
 *   calendar-14  the preset model: grouped by unit of time rather than a flat
 *                list, and selecting one moves the calendar to that month so you
 *                can see what you picked instead of trusting a label.
 *
 * The trigger states the current range in words and costs one line of toolbar.
 * An earlier version put five preset buttons in the toolbar itself: one click to
 * "last 7 days", and 340px of chrome repeating it every day, on a bar that also
 * carries rig, well and search.
 *
 * `today` is a prop, not a clock read — it keeps this testable and stops "Today"
 * quietly meaning a different day than the data does.
 */

export interface DateRangePreset {
  id: string;
  label: string;
  range: (today: Date) => DateRange;
}

export interface DateRangePresetGroup {
  label: string;
  presets: DateRangePreset[];
}

/**
 * Default presets: everything looks backwards.
 *
 * calendar-14 ships Tomorrow / Next 7 days / Next month, which are right for a
 * booking UI and useless on an operations list — no drilling report exists for
 * tomorrow, so those options can only ever return an empty table. A scheduling
 * screen should pass its own forward-looking groups via `presetGroups`.
 */
export const PAST_PRESETS: DateRangePresetGroup[] = [
  {
    label: "Days",
    presets: [
      { id: "today", label: "Today", range: (t) => ({ from: t, to: t }) },
      {
        id: "yesterday",
        label: "Yesterday",
        range: (t) => ({ from: subDays(t, 1), to: subDays(t, 1) }),
      },
    ],
  },
  {
    label: "Weeks",
    presets: [
      { id: "7d", label: "Last 7 days", range: (t) => ({ from: subDays(t, 6), to: t }) },
      {
        id: "wtd",
        label: "Week to date",
        range: (t) => ({ from: startOfWeek(t, { weekStartsOn: 0 }), to: t }),
      },
    ],
  },
  {
    label: "Months",
    presets: [
      { id: "30d", label: "Last 30 days", range: (t) => ({ from: subDays(t, 29), to: t }) },
      { id: "mtd", label: "Month to date", range: (t) => ({ from: startOfMonth(t), to: t }) },
      {
        id: "lastmonth",
        label: "Last month",
        range: (t) => ({
          from: startOfMonth(subMonths(t, 1)),
          to: endOfMonth(subMonths(t, 1)),
        }),
      },
      { id: "90d", label: "Last 90 days", range: (t) => ({ from: subDays(t, 89), to: t }) },
    ],
  },
];

/** Forward-looking groups, for scheduling screens rather than record lists. */
export const FUTURE_PRESETS: DateRangePresetGroup[] = [
  {
    label: "Days",
    presets: [
      { id: "today", label: "Today", range: (t) => ({ from: t, to: t }) },
      {
        id: "tomorrow",
        label: "Tomorrow",
        range: (t) => ({ from: addDays(t, 1), to: addDays(t, 1) }),
      },
    ],
  },
  {
    label: "Weeks",
    presets: [
      {
        id: "next7",
        label: "Next 7 days",
        range: (t) => ({ from: t, to: addDays(t, 6) }),
      },
      {
        id: "next14",
        label: "Next 14 days",
        range: (t) => ({ from: t, to: addDays(t, 13) }),
      },
    ],
  },
  {
    label: "Months",
    presets: [
      { id: "next30", label: "Next 30 days", range: (t) => ({ from: t, to: addDays(t, 29) }) },
      {
        id: "nextmonth",
        label: "Next month",
        range: (t) => ({
          from: startOfMonth(addMonths(t, 1)),
          to: endOfMonth(addMonths(t, 1)),
        }),
      },
    ],
  },
];

export interface DateRangeValue {
  /** Preset id, or `"custom"` when the range came from the calendar. */
  preset: string;
  range?: DateRange;
}

function sameDay(a?: Date, b?: Date) {
  return !!a && !!b && a.toDateString() === b.toDateString();
}

function fmt(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Resolve a preset id against a set of groups. */
export function resolvePreset(
  id: string,
  today: Date,
  groups: DateRangePresetGroup[] = PAST_PRESETS,
): DateRange | undefined {
  for (const g of groups) {
    const p = g.presets.find((x) => x.id === id);
    if (p) return p.range(today);
  }
  return undefined;
}

/** What the trigger says: a preset states its name, a custom range its dates. */
export function describeRange(
  value: DateRangeValue,
  groups: DateRangePresetGroup[] = PAST_PRESETS,
): string {
  if (value.preset !== "custom") {
    for (const g of groups) {
      const p = g.presets.find((x) => x.id === value.preset);
      if (p) return p.label;
    }
  }
  const { from, to } = value.range ?? {};
  if (!from) return "Select dates";
  if (!to || sameDay(from, to)) return fmt(from);
  return `${fmt(from)} – ${fmt(to)}`;
}

export interface DateRangeFilterProps {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  /** Today's date. Passed in rather than read from the clock — see above. */
  today: Date;
  /** Defaults to backward-looking groups. Pass FUTURE_PRESETS for scheduling. */
  presetGroups?: DateRangePresetGroup[];
  label?: string;
  className?: string;
}

export function DateRangeFilter({
  value,
  onChange,
  today,
  presetGroups = PAST_PRESETS,
  label = "Date range",
  className,
}: DateRangeFilterProps) {
  const [open, setOpen] = React.useState(false);
  // The calendar's visible month is controlled so that picking a preset moves it
  // — calendar-14's best detail. Without it "Last month" selects dates you
  // cannot see, and you are trusting a label instead of reading a range.
  const [month, setMonth] = React.useState<Date>(value.range?.from ?? today);

  const applyPreset = (p: DateRangePreset) => {
    const range = p.range(today);
    onChange({ preset: p.id, range });
    setMonth(range.to ?? range.from ?? today);
    // A preset is a complete answer, so close. A custom range is not — see below.
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`${label}: ${describeRange(value, presetGroups)}`}
          className={cn("h-9 justify-between gap-2 rounded-lg font-normal", className)}
        >
          <span className="flex items-center gap-2">
            <CalendarIcon aria-hidden className="size-4 text-muted-foreground" />
            <span className="font-medium">{describeRange(value, presetGroups)}</span>
          </span>
          <ChevronDown aria-hidden className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-auto p-0" align="start">
        {/* Horizontal: calendar left, presets right, both visible at once.
            calendar-14 stacks them and puts the presets in a 44px scroll area,
            which hides two of the three groups behind a scroll nobody notices. */}
        <div className="flex flex-col sm:flex-row">
          <div className="p-2">
            <Calendar
              mode="range"
              selected={value.range}
              month={month}
              onMonthChange={setMonth}
              // Deliberately does NOT close: after picking `from` the user is
              // mid-gesture with `to` still to choose. Closing here is the most
              // common way a range picker becomes infuriating.
              onSelect={(range) => onChange({ preset: "custom", range })}
              numberOfMonths={1}
              autoFocus
              className="p-0"
            />
          </div>

          <div
            className="min-w-52 border-t border-border p-3 sm:border-t-0 sm:border-l"
            role="group"
            aria-label="Date range presets"
          >
            <div className="flex flex-col gap-3">
              {presetGroups.map((group) => (
                <div key={group.label}>
                  <p className="mb-1.5 px-1 text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {group.label}
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {group.presets.map((p) => {
                      const active = value.preset === p.id;
                      return (
                        <Button
                          key={p.id}
                          variant="ghost"
                          size="sm"
                          aria-pressed={active}
                          onClick={() => applyPreset(p)}
                          className={cn(
                            "h-7 justify-center gap-1.5 border border-border text-xs font-normal",
                            // The dot is not decoration: `aria-pressed` covers
                            // screen readers, but a tinted background alone is a
                            // colour-only cue, which WCAG 1.4.1 does not accept.
                            active &&
                              "border-primary bg-accent text-accent-foreground hover:bg-accent",
                          )}
                        >
                          {active && (
                            <span
                              aria-hidden
                              className="size-1.5 shrink-0 rounded-full bg-primary"
                            />
                          )}
                          {p.label}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
