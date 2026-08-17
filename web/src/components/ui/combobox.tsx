"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Combobox — a searchable single-select.
 *
 * shadcn does not ship this as a component; it is documented as a Command +
 * Popover *pattern*, which means every project assembles its own and they all
 * differ in the details that matter — whether the trigger has an accessible
 * name, whether the empty state says anything useful, whether the selected
 * value is announced. Forty KOC apps assembling it forty times is exactly the
 * outcome the registry exists to prevent.
 *
 * WHEN TO USE THIS INSTEAD OF Select
 * ----------------------------------
 * Only when the list is long enough that scanning it is work — a well register,
 * every KOC rig. For a handful of statuses, `Select` is faster and lighter, and
 * a search box over four options is noise. The threshold is roughly ten items.
 */

export interface ComboboxOption {
  value: string;
  label: string;
  /** Optional second line — a rig's asset, a well's field. */
  hint?: string;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value?: string;
  onChange: (value: string | undefined) => void;
  /** Shown on the trigger when nothing is selected. */
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  /**
   * Accessible name for the trigger. Required — a combobox whose button reads
   * only "Select…" tells a screen-reader user nothing about what they are
   * choosing, and it is the single most common defect in hand-rolled versions.
   */
  label: string;
  /** Allow clearing back to no selection. */
  clearable?: boolean;
  className?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No matches.",
  label,
  clearable = true,
  className,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={label}
            className={cn("justify-between font-normal", className)}
          />
        }
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronsUpDown aria-hidden className="ml-2 size-4 shrink-0 opacity-50" />
      </PopoverTrigger>

      {/* Bracket syntax, not `w-(--anchor-width)`: tailwind-merge 2.x does not
          classify the v4 paren shorthand as a width utility, so it cannot
          displace PopoverContent's default w-72 — measured as a 288px popup on
          a 182px trigger. `w-[var(…)]` merges correctly. */}
      <PopoverContent className="w-[var(--anchor-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {clearable && (
                <CommandItem
                  value="__all__"
                  onSelect={() => {
                    onChange(undefined);
                    setOpen(false);
                  }}
                >
                  <span className="flex-1 text-muted-foreground">{placeholder}</span>
                  {!selected && <Check aria-hidden className="size-4" />}
                </CommandItem>
              )}
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  // cmdk filters on `value`, so the label has to be in it or
                  // typing a visible option's name would filter it away.
                  value={`${o.label} ${o.hint ?? ""}`}
                  onSelect={() => {
                    onChange(o.value === value ? undefined : o.value);
                    setOpen(false);
                  }}
                >
                  <span className="grid flex-1">
                    <span className="truncate">{o.label}</span>
                    {o.hint && (
                      <span className="truncate text-xs text-muted-foreground">{o.hint}</span>
                    )}
                  </span>
                  {o.value === value && <Check aria-hidden className="size-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
