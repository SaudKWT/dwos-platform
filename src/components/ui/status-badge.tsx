import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Info,
  OctagonAlert,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * StatusBadge — operational state for wells, assets, jobs and runs.
 *
 * This is the most safety-relevant component in the system, and its API is shaped
 * to make the unsafe version unbuildable rather than merely discouraged.
 *
 * WCAG 1.4.1 ("Use of Color") requires that colour is never the *only* carrier of
 * meaning. The usual way that rule is broken is not malice — it is a `<Badge
 * variant="destructive">` with a colour and nothing else, shipped by someone in a
 * hurry. So this component does not accept a colour. It accepts a `status`, and
 * derives colour, icon and label together. There is no prop that lets a caller
 * keep the red and drop the icon.
 *
 * Why it matters here specifically: roughly 1 in 12 men has a colour-vision
 * deficiency, and KOC's operational readership skews heavily male. A red/green
 * status pair distinguished by hue alone is unreadable for a meaningful share of
 * the people this dashboard is for. The icon is not decoration — for those
 * readers it is the entire signal.
 */
export type OperationalStatus =
  | "producing"
  | "normal"
  | "warning"
  | "critical"
  | "shutin"
  | "maintenance"
  | "offline"
  | "unknown";

interface StatusSpec {
  /** Default human-readable label. Overridable, but never removable. */
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  className: string;
  /** Prefix announced to screen readers, so the state is spoken, not just seen. */
  srPrefix: string;
}

const STATUS: Record<OperationalStatus, StatusSpec> = {
  producing: {
    label: "Producing",
    icon: CheckCircle2,
    className: "bg-success/12 text-success border-success/30",
    srPrefix: "Status: producing",
  },
  normal: {
    label: "Normal",
    icon: CheckCircle2,
    className: "bg-success/12 text-success border-success/30",
    srPrefix: "Status: normal",
  },
  warning: {
    label: "Warning",
    icon: AlertTriangle,
    className: "bg-warning/12 text-warning border-warning/30",
    srPrefix: "Status: warning",
  },
  critical: {
    label: "Critical",
    icon: OctagonAlert,
    // The only status that gets a solid fill. In a wall of outlined badges the
    // filled one is pre-attentively visible — an operator finds it without
    // reading. Reserved exclusively for "act now"; using it decoratively
    // anywhere else devalues it everywhere.
    className: "bg-destructive text-destructive-foreground border-destructive",
    srPrefix: "Status: critical, action required",
  },
  shutin: {
    label: "Shut-in",
    icon: CircleSlash,
    className: "bg-muted text-muted-foreground border-border",
    srPrefix: "Status: shut in",
  },
  maintenance: {
    label: "Maintenance",
    icon: Wrench,
    className: "bg-info/12 text-info border-info/30",
    srPrefix: "Status: under maintenance",
  },
  offline: {
    label: "Offline",
    icon: CircleDashed,
    className: "bg-muted text-muted-foreground border-border",
    srPrefix: "Status: offline",
  },
  unknown: {
    label: "Unknown",
    icon: Info,
    className: "bg-muted text-muted-foreground border-border",
    srPrefix: "Status: unknown",
  },
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: OperationalStatus;
  /** Override the displayed text (e.g. "Shut-in — pump 3"). The icon stays. */
  label?: string;
  /**
   * Hide the text label, leaving the icon. Only for genuinely space-constrained
   * cells — the accessible name is preserved via sr-only text, so this stays
   * conformant, but a visible label is better for everyone. Defaults to false.
   */
  iconOnly?: boolean;
}

const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ status, label, iconOnly = false, className, ...props }, ref) => {
    const spec = STATUS[status] ?? STATUS.unknown;
    const Icon = spec.icon;
    const text = label ?? spec.label;

    return (
      <span
        ref={ref}
        data-slot="status-badge"
        data-status={status}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm border font-medium",
          "text-2xs whitespace-nowrap",
          iconOnly ? "p-1" : "px-2 py-0.5",
          spec.className,
          className,
        )}
        {...props}
      >
        {/* aria-hidden because the state is already announced via sr-only text —
            otherwise a screen reader says it twice. */}
        <Icon className="size-3 shrink-0" aria-hidden="true" />
        <span className="sr-only">{spec.srPrefix}</span>
        {!iconOnly && <span aria-hidden="true">{text}</span>}
      </span>
    );
  },
);
StatusBadge.displayName = "StatusBadge";

export { StatusBadge, STATUS as statusSpecs };
