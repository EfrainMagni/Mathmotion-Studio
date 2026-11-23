import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function Section({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-white/5">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-300 hover:bg-white/5"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon}
        {title}
      </button>
      {open && <div className="space-y-2 px-3 pb-3">{children}</div>}
    </section>
  );
}

export const btn =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-white/10 bg-ink-700 px-2.5 py-1.5 text-xs font-medium text-slate-100 hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ink-700';
export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-md bg-cyan-500 px-2.5 py-1.5 text-xs font-semibold text-ink-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-cyan-500';
export const input =
  'w-full rounded-md border border-white/10 bg-ink-900 px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan-400 disabled:opacity-40';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-slate-300">
      <span className="shrink-0">{label}</span>
      <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{children}</span>
    </label>
  );
}

/** Entrada numérica que acepta escritura libre y confirma valores válidos. */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 0.1,
  disabled,
  className,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      className={className ?? input}
      value={Number.isFinite(value) ? Math.round(value * 1000) / 1000 : ''}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isFinite(v)) return;
        onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
      }}
    />
  );
}
