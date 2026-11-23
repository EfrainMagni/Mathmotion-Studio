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
    <section className="border-b border-bezel">
      <button
        className="flex w-full items-center min-h-6 gap-1.5 px-2 text-left text-xs font-semibold text-slate-300 hover:bg-white/5"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon}
        {title}
      </button>
      {open && <div className="space-y-1.5 px-2 pb-2">{children}</div>}
    </section>
  );
}

export const btn =
  'inline-flex items-center justify-center gap-1.5 min-h-6 rounded border border-bezel bg-ink-700 px-1.5 py-0.5 text-xs font-medium text-slate-100 hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ink-700';
export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 min-h-6 rounded border border-accent/50 bg-accent-soft px-1.5 py-0.5 text-xs font-semibold text-accent-light hover:border-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent-soft';
export const input =
  'min-h-6 w-full rounded border border-bezel bg-ink-900 px-1.5 py-0.5 text-xs text-slate-100 outline-none focus:border-accent disabled:opacity-40';

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
  // Mientras se escribe se conserva el texto tal cual («0.», «0.4»); el límite se aplica al confirmar.
  const [draft, setDraft] = useState<string | null>(null);
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      className={className ?? input}
      value={draft ?? (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : '')}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v) && v >= lo && v <= hi) onChange(v);
      }}
      onBlur={() => {
        if (draft === null) return;
        const v = parseFloat(draft);
        if (Number.isFinite(v)) onChange(Math.min(hi, Math.max(lo, v)));
        setDraft(null);
      }}
    />
  );
}
