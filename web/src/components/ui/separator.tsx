import * as React from "react"
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "@/lib/utils"

/**
 * Base UI's separator always renders `role="separator"` with an
 * aria-orientation. Radix had a `decorative` prop that silenced it; Base has
 * no equivalent, and a rule between sections is legitimately a separator —
 * the prop is dropped rather than faked (a `role="none"` override would leave
 * a stray aria-orientation for axe to flag). Nobody passed it.
 */
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive>) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
