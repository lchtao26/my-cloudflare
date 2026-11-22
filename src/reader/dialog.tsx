import { useLayoutEffect, useRef, type ReactNode } from "react";

export function ReaderDialog({ id, label, mode, dismiss, children }: {
  id: string;
  label: string;
  mode?: "body" | "mark" | "token";
  dismiss: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
  }, []);

  function outside(node: HTMLDialogElement, x: number, y: number) {
    const bounds = node.getBoundingClientRect();
    return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
  }

  return (
    <dialog id={id} ref={dialog} aria-label={label} closedby="any" data-mode={mode} onClose={dismiss}
      onPointerDown={event => {
        pressedOutside.current = !("closedBy" in event.currentTarget)
          && outside(event.currentTarget, event.clientX, event.clientY);
      }}
      onPointerCancel={() => { pressedOutside.current = false; }}
      onClick={event => {
        if (pressedOutside.current && outside(event.currentTarget, event.clientX, event.clientY)) {
          event.currentTarget.close();
        }
        pressedOutside.current = false;
      }}>
      {children}
    </dialog>
  );
}
