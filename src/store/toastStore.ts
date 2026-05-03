import { create } from "zustand";

export type ToastKind = "info" | "warn" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  // Optional action — clicking the toast can route the user somewhere
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id"> & { id?: string; ttlMs?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const DEFAULT_TTL_MS = 8000;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (t) => {
    const id = t.id ?? Math.random().toString(36).slice(2, 10);
    set((s) => ({ toasts: [...s.toasts, { id, kind: t.kind, title: t.title, body: t.body, actionLabel: t.actionLabel, onAction: t.onAction }] }));
    const ttl = t.ttlMs ?? DEFAULT_TTL_MS;
    if (ttl > 0) {
      setTimeout(() => get().dismiss(id), ttl);
    }
    return id;
  },

  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  clear: () => set({ toasts: [] }),
}));
