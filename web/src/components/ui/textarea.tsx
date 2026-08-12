/**
 * Canonical shadcn textarea, NOT @koc — there is no @koc/textarea, and this page
 * has three. Its tokens are already KOC's (border-input, ring-ring,
 * text-muted-foreground) because the system follows the shadcn contract, so it
 * is on-brand untouched.
 *
 * One change on the way in: `transition-[color,box-shadow]` carried no duration,
 * so Tailwind's 150ms applied — off this system's scale, and check:motion fails
 * it. This is worth knowing generally: a canonical shadcn component does not
 * pass KOC's motion gate, so anything pulled from that registry needs the same
 * line. It is the concrete argument for @koc/textarea existing.
 */
import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] duration-fast ease-out outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
