// Shared chrome for the vessel data-entry forms, built on @koc primitives.
//
// WHY THIS FILE STILL EXISTS ALONGSIDE @koc/card
// ----------------------------------------------
// Two of these are genuinely missing from the design system rather than
// duplicated from it: the accent-striped section card (one colour per section of
// a nine-section form, so you always know where you are) and the Nil/Reportable
// toggle. Both are form-layout, which @koc deliberately defers until real KOC
// forms exist — this is one of the three real forms that decision was waiting
// for, so these are candidates to promote into the registry rather than
// permanent local components.
//
// Everything underneath them is the system's: Card, Label, Input, and the
// semantic tokens. Nothing here defines a colour.

import { useId, useState } from "react"
import { ChevronRight } from "lucide-react"

import { Card as KocCard, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * The class string @koc/input applies, minus its fixed `h-9`.
 *
 * The task log puts up to seven controls on one row and runs to forty rows, so
 * the dense inputs are native `<input>` / `<select>` elements at a smaller
 * height rather than the Input component and a Radix Select. That is a density
 * decision, not a styling one: `border-input` is carried through verbatim
 * because it is the token holding WCAG 1.4.11, and softening it to
 * `border-border` would make the fields invisible to low-vision users while
 * looking perfectly fine in review.
 */
export const inputCls = cn(
  "flex w-full rounded-md border border-input bg-background px-2 py-1.5",
  "text-sm shadow-xs transition-colors duration-fast ease-out",
  "placeholder:text-muted-foreground/60",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30",
)

/*
 * The eight-colour section palette is gone.
 *
 * It existed to break up nine identical white cards — a layout problem being
 * solved with hue, at a cost of sixteen raw palette steps in a system whose
 * first rule is that colour comes from tokens. Sections are identified by title
 * and position now, and the restructure keeps fewer of them on screen at once,
 * which is the actual fix. Colour in this form is reserved for meaning: the task
 * log's row families (standby / transit / cargo) and validation state.
 */

export function Card({
  title, subtitle, required, id, children,
}: {
  title: string; subtitle?: string; required?: boolean
  id?: string; children: React.ReactNode
}) {
  return (
    <KocCard id={id}>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          {title}
          {required && <span className="text-destructive" title="Required">*</span>}
        </CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent className="p-4 pt-0">{children}</CardContent>
    </KocCard>
  )
}

/**
 * A card that starts shut. Deck cargo is filled in 11 of 256 imported reports
 * and the crew list in 11 — sections that rare had been sitting open at the same
 * size as the task log, which every report fills. `summary` keeps them honest
 * when closed: a shut section holding data has to say so.
 */
export function CollapsibleCard({
  title, subtitle, open, onOpenChange, summary, action, id, children,
}: {
  title: string; subtitle?: string
  open: boolean; onOpenChange: (v: boolean) => void
  summary?: string; action?: string; id?: string; children: React.ReactNode
}) {
  const bodyId = useId()
  return (
    <KocCard id={id}>
      <CardHeader className={cn("p-4", open && "pb-0")}>
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex w-full items-center gap-2 text-left text-sm font-semibold"
        >
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-fast ease-out",
              open && "rotate-90",
            )}
          />
          {title}
          {summary && (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-2xs font-medium text-muted-foreground">
              {summary}
            </span>
          )}
          {!open && !summary && action && (
            <span className="ml-auto text-xs font-medium text-primary">{action}</span>
          )}
        </button>
      </CardHeader>
      {open && (
        <CardContent id={bodyId} className="p-4 pt-3">
          {subtitle && <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>}
          {children}
        </CardContent>
      )}
    </KocCard>
  )
}

/**
 * A labelled field.
 *
 * The label is a real <label> WRAPPING the control, not a sibling with htmlFor.
 * That is deliberate and was a bug fix: this started as a wrapping label, the
 * port to @koc/label turned it into a <div> + <Label htmlFor?>, and htmlFor was
 * optional — so almost no call site passed one. axe found eight unlabelled
 * controls on the report form and two selects with no accessible name.
 *
 * Implicit association needs no id, so it cannot rot the way forty hand-written
 * htmlFor/id pairs would. @koc/label is not used here for exactly that reason:
 * nesting a <label> inside a <label> is invalid, and its contribution is the
 * type styling, which is reproduced below.
 */
export function Field({ label, hint, children, className, required }: {
  label: string; hint?: string; children: React.ReactNode
  className?: string; required?: boolean
}) {
  return (
    <label className={cn("block", className)}>
      <span
        className={cn(
          "mb-1 block text-xs",
          required ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
        )}
      >
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-muted-foreground/80">{hint}</span>}
    </label>
  )
}

export function StatusText({ status }: { status: { text: string; tone: "ok" | "err" | "" } }) {
  if (!status.text) return null
  return (
    <span
      className={cn(
        "text-sm",
        status.tone === "ok" && "text-success",
        status.tone === "err" && "text-destructive",
        status.tone === "" && "text-muted-foreground",
      )}
      role={status.tone === "err" ? "alert" : "status"}
    >
      {status.text}
    </span>
  )
}

/**
 * The "nothing to report / here's what happened" pair used by safety and delays.
 *
 * The value stays a plain string so an imported report round-trips untouched:
 * switching back to Nil restores whatever nil-ish wording the source used
 * ("NIL", "NA Delay") rather than imposing ours.
 */
export function NilToggle({
  label, value, isNil, nilWord, yesWord, placeholder, onChange, id,
}: {
  label: string; value: string; isNil: boolean
  nilWord: string; yesWord: string; placeholder: string
  onChange: (v: string) => void; id?: string
}) {
  const [rememberedNil, setRememberedNil] = useState(nilWord)
  const set = (nil: boolean) => {
    if (nil) {
      onChange(isNil ? value : rememberedNil)
    } else {
      if (isNil && value) setRememberedNil(value)
      onChange("")
    }
  }
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex overflow-hidden rounded-md border border-input" role="group" aria-label={label}>
        <button
          type="button" onClick={() => set(true)} aria-pressed={isNil}
          className={cn(
            "flex-1 px-2 py-1 text-xs font-medium transition-colors duration-fast ease-out",
            // hover is 60% of the fill, not the whole fill. --accent, --secondary
            // and --muted became the same value in v0.1.4, so a full-strength
            // hover renders identically to the selected half and a passing
            // cursor reads as an answer. Same resolution @koc/sidebar uses.
            isNil ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-accent/60",
          )}
        >
          {nilWord}
        </button>
        <button
          type="button" onClick={() => set(false)} aria-pressed={!isNil}
          className={cn(
            "flex-1 border-l border-input px-2 py-1 text-xs font-medium transition-colors duration-fast ease-out",
            !isNil ? "bg-destructive/15 text-destructive" : "text-muted-foreground hover:bg-accent/60",
          )}
        >
          {yesWord}
        </button>
      </div>
      {!isNil && (
        <input
          id={id}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn(inputCls, "mt-1.5")}
          aria-label={`${label} — details`}
        />
      )}
    </div>
  )
}
