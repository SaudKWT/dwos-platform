// Shared chrome for the two data-entry forms: the coloured section card, the
// labelled field, the input class, the status line. Extracted from FormsPage so
// the Daily Vessel Report and the Movement Plan keep looking like one form
// while they live in separate files.

import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export const inputCls = 'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm shadow-sm outline-none transition-shadow placeholder:text-muted-foreground/50 focus:border-ring focus:ring-2 focus:ring-ring/30'

export type Accent = 'blue' | 'red' | 'violet' | 'teal' | 'amber' | 'green' | 'cyan' | 'slate'

const ACCENTS: Record<Accent, { bar: string; dot: string }> = {
  blue:   { bar: 'border-l-blue-500',    dot: 'bg-blue-500' },
  red:    { bar: 'border-l-red-500',     dot: 'bg-red-500' },
  violet: { bar: 'border-l-violet-500',  dot: 'bg-violet-500' },
  teal:   { bar: 'border-l-teal-500',    dot: 'bg-teal-500' },
  amber:  { bar: 'border-l-amber-500',   dot: 'bg-amber-500' },
  green:  { bar: 'border-l-green-500',   dot: 'bg-green-500' },
  cyan:   { bar: 'border-l-cyan-500',    dot: 'bg-cyan-500' },
  slate:  { bar: 'border-l-slate-400',   dot: 'bg-slate-400' },
}

export function Card({ title, subtitle, accent = 'slate', required, id, children }: {
  title: string; subtitle?: string; accent?: Accent; required?: boolean
  id?: string; children: React.ReactNode
}) {
  const a = ACCENTS[accent]
  return (
    <section id={id} className={cn('rounded-lg border border-l-4 bg-card p-4', a.bar)}>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <span className={cn('inline-block h-2.5 w-2.5 rounded-full', a.dot)} />
        {title}
        {required && <span className="text-destructive" title="Required">*</span>}
      </h2>
      {subtitle && <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>}
      {!subtitle && <div className="mb-3" />}
      {children}
    </section>
  )
}

/**
 * A card that starts shut. Deck cargo is filled in 11 of 256 reports and the
 * crew list in 11 — sections that rare had been sitting open at the same size
 * as the task log, which every report fills. `summary` keeps them honest when
 * closed: a shut section that already holds data has to say so.
 */
export function CollapsibleCard({
  title, subtitle, accent = 'slate', open, onOpenChange, summary, action, id, children,
}: {
  title: string; subtitle?: string; accent?: Accent
  open: boolean; onOpenChange: (v: boolean) => void
  summary?: string; action?: string; id?: string; children: React.ReactNode
}) {
  const a = ACCENTS[accent]
  const bodyId = useId()
  return (
    <section id={id} className={cn('rounded-lg border border-l-4 bg-card', a.bar, open ? 'p-4' : 'px-4 py-3')}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-2 text-left text-sm font-semibold"
      >
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', a.dot)} />
        {title}
        {summary && (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {summary}
          </span>
        )}
        {!open && !summary && action && (
          <span className="ml-auto text-xs font-medium text-primary">{action}</span>
        )}
      </button>
      {open && (
        <div id={bodyId} className="mt-3">
          {subtitle && <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>}
          {children}
        </div>
      )}
    </section>
  )
}

export function Field({ label, hint, children, className, required }: {
  label: string; hint?: string; children: React.ReactNode; className?: string; required?: boolean
}) {
  return (
    <label className={cn('block', className)}>
      <span className={cn(
        'mb-1 block text-xs',
        required ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
      )}>
        {label}{required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground/80">{hint}</span>}
    </label>
  )
}

export function StatusText({ status }: { status: { text: string; tone: 'ok' | 'err' | '' } }) {
  if (!status.text) return null
  return (
    <span className={cn(
      'text-sm',
      status.tone === 'ok' && 'text-success',
      status.tone === 'err' && 'text-destructive',
      status.tone === '' && 'text-muted-foreground',
    )} role={status.tone === 'err' ? 'alert' : 'status'}>
      {status.text}
    </span>
  )
}

/**
 * The "nothing to report / here's what happened" pair used by safety and
 * delays. The value stays a plain string so an imported report round-trips
 * untouched: switching to Nil restores whatever nil-ish wording the source
 * used ("NIL", "NA Delay") rather than imposing ours.
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
    if (nil) { onChange(isNil ? value : rememberedNil) }
    else {
      if (isNil && value) setRememberedNil(value)
      onChange('')
    }
  }
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex overflow-hidden rounded-md border border-input" role="group" aria-label={label}>
        <button
          type="button" onClick={() => set(true)} aria-pressed={isNil}
          className={cn('flex-1 px-2 py-1 text-xs font-medium transition-colors',
            isNil ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent')}
        >
          {nilWord}
        </button>
        <button
          type="button" onClick={() => set(false)} aria-pressed={!isNil}
          className={cn('flex-1 border-l border-input px-2 py-1 text-xs font-medium transition-colors',
            !isNil ? 'bg-destructive/15 text-destructive' : 'text-muted-foreground hover:bg-accent')}
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
          className={cn(inputCls, 'mt-1.5')}
          aria-label={`${label} — details`}
        />
      )}
    </div>
  )
}
