import React, { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "../ui/button.jsx";

export default function ConfirmDialog({ open, onOpenChange, title, description, onConfirm, busy = false, confirmLabel = "Confirmer" }) {
  const cancelRef = useRef(null);
  return <Dialog.Root open={open} onOpenChange={value => !busy && onOpenChange(value)}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-bg-primary/80 backdrop-blur-sm" />
    <Dialog.Content role="alertdialog" data-testid="confirm-dialog" onOpenAutoFocus={event => { event.preventDefault(); cancelRef.current?.focus(); }} onPointerDownOutside={event => event.preventDefault()} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-strong bg-bg-card p-6 shadow-xl">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-red/10 text-brand-red"><AlertTriangle size={24} /></div>
      <Dialog.Title className="text-lg font-semibold text-text-primary">{title}</Dialog.Title>
      <Dialog.Description className="mt-2 text-sm leading-relaxed text-text-secondary">{description}</Dialog.Description>
      <div className="mt-6 flex justify-end gap-3"><Button ref={cancelRef} variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Annuler</Button><Button variant="destructive" disabled={busy} onClick={onConfirm}>{busy && <Loader2 size={15} className="animate-spin" />}{confirmLabel}</Button></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function useConfirmDialog() {
  const [options, setOptions] = useState(null);
  const pending = useRef(null);
  useEffect(() => () => pending.current?.(false), []);
  const finish = value => { pending.current?.(value); pending.current = null; setOptions(null); };
  const ask = next => new Promise(resolve => { pending.current?.(false); pending.current = resolve; setOptions(next); });
  return { ask, dialog: options && <ConfirmDialog {...options} open onOpenChange={open => !open && finish(false)} onConfirm={() => finish(true)} /> };
}
