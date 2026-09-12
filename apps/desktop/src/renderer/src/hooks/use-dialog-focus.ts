import { useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]';

interface DialogFocusOwner {
  readonly dialog: HTMLElement;
  previousFocus: Element | null;
  readonly focusFirst: () => void;
}

// Explicit ownership makes a newly opened modal suspend the one below it.
// Registration follows the open lifecycle, independent of CSS stacking values.
const dialogOwners: DialogFocusOwner[] = [];

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => {
    if (
      element.tabIndex < 0 ||
      element.matches(':disabled, input[type="hidden"]')
    ) {
      return false;
    }
    let current: HTMLElement | null = element;
    while (current !== null) {
      const style = window.getComputedStyle(current);
      if (
        current.hidden ||
        current.hasAttribute('inert') ||
        current.getAttribute('aria-hidden') === 'true' ||
        style.display === 'none' ||
        style.visibility === 'hidden'
      ) {
        return false;
      }
      if (current === dialog) break;
      current = current.parentElement;
    }
    return true;
  });
}

/** Keeps keyboard interaction inside an open dialog and returns to its trigger. */
export function useDialogFocus({
  open,
  onDismiss,
  dismissible = true,
  initialFocusRef,
}: {
  readonly open: boolean;
  readonly onDismiss: () => void;
  readonly dismissible?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
}): RefObject<HTMLElement | null> {
  const dialogRef = useRef<HTMLElement>(null);
  const optionsRef = useRef({ onDismiss, dismissible, initialFocusRef });
  optionsRef.current = { onDismiss, dismissible, initialFocusRef };

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || dialog === null) return;
    const previousFocus = document.activeElement;
    const focusFirst = () => {
      const controls = focusableElements(dialog);
      const preferred = optionsRef.current.initialFocusRef?.current;
      (preferred !== null &&
      preferred !== undefined &&
      controls.includes(preferred)
        ? preferred
        : (controls[0] ?? dialog)
      ).focus({ preventScroll: true });
    };
    const owner: DialogFocusOwner = { dialog, previousFocus, focusFirst };
    dialogOwners.push(owner);
    focusFirst();

    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogOwners.at(-1) !== owner) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (optionsRef.current.dismissible) optionsRef.current.onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusableElements(dialog);
      const activeIndex = controls.findIndex(
        (element) => element === document.activeElement,
      );
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
      } else if (
        activeIndex === -1 ||
        (event.shiftKey
          ? activeIndex === 0
          : activeIndex === controls.length - 1)
      ) {
        event.preventDefault();
        (event.shiftKey ? controls[controls.length - 1] : controls[0])?.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (dialogOwners.at(-1) !== owner) return;
      if (event.target instanceof Node && !dialog.contains(event.target))
        focusFirst();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      const ownerIndex = dialogOwners.indexOf(owner);
      const wasTop = dialogOwners.at(-1) === owner;
      dialogOwners.splice(ownerIndex, 1);
      // If a background modal disappears first, preserve the restoration
      // chain without taking focus away from the active foreground modal.
      for (const remaining of dialogOwners) {
        if (
          remaining.previousFocus !== null &&
          dialog.contains(remaining.previousFocus)
        ) {
          remaining.previousFocus = owner.previousFocus;
        }
      }
      if (!wasTop) return;
      const nextOwner = dialogOwners.at(-1);
      const restoreTarget = owner.previousFocus;
      if (
        restoreTarget instanceof HTMLElement &&
        restoreTarget.isConnected &&
        (nextOwner === undefined || nextOwner.dialog.contains(restoreTarget))
      ) {
        restoreTarget.focus({ preventScroll: true });
      }
      if (
        nextOwner !== undefined &&
        !nextOwner.dialog.contains(document.activeElement)
      ) {
        nextOwner.focusFirst();
      }
    };
  }, [open]);

  return dialogRef;
}
