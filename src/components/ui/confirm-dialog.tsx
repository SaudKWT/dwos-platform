"use client";

import * as React from "react";
import { AlertTriangle, Trash2, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * ConfirmDialog — a decision that cannot be undone.
 *
 * Adapted from shadcn-space's dialog-02: centred icon, plain question, two
 * equal-weight buttons. Two things changed in the port.
 *
 * FIRST, IT TAKES THE SUBJECT AS A PROP.
 * The original hardcodes "Delete Item". A confirmation that does not name what
 * it is about to destroy is the mechanism by which people delete the wrong
 * thing — you click through three identical dialogs and the fourth one was a
 * different record. `subject` is required for exactly that reason, so the
 * question reads "Delete report BG-1042?" and the user can catch the mistake.
 *
 * SECOND, THE CONFIRM BUTTON IS NOT AUTOFOCUSED.
 * Radix focuses the first focusable element on open. For a destructive dialog
 * that must be Cancel, not Delete — otherwise a stray Enter, which is a very
 * common way to dismiss a dialog, destroys the record. The cancel button is
 * ordered first and carries the initial focus.
 */

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What is about to happen, e.g. "Delete report". */
  title: string;
  /** What it will happen to, e.g. "BG-1042". Named so the user can catch a mistake. */
  subject: string;
  /** Consequence, in plain words. */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** `destructive` is the default. `caution` for reversible-but-serious. */
  tone?: "destructive" | "caution";
  icon?: LucideIcon;
  /** Disables the confirm button while an async action runs. */
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  subject,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  tone = "destructive",
  icon,
  busy = false,
}: ConfirmDialogProps) {
  const Icon = icon ?? (tone === "destructive" ? Trash2 : AlertTriangle);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <div className="flex flex-col items-center gap-4 text-center">
          <div
            className={cn(
              "flex size-12 items-center justify-center rounded-full",
              tone === "destructive"
                ? "bg-destructive/10 text-destructive"
                : "bg-warning/10 text-warning",
            )}
          >
            <Icon aria-hidden className="size-5" />
          </div>

          <DialogHeader className="items-center">
            <DialogTitle>
              {title} {subject}?
            </DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
        </div>

        {/* Cancel first, and it takes the initial focus. Radix focuses the first
            focusable child on open; on a destructive dialog that must not be the
            destructive button. */}
        <DialogFooter className="sm:justify-center">
          <Button
            variant="outline"
            className="flex-1"
            autoFocus
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "destructive" ? "destructive" : "default"}
            className="flex-1"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel ?? (tone === "destructive" ? "Delete" : "Continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
