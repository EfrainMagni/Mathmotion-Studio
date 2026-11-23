import { useRef, useState } from 'react';
import { generateManim } from '../engine/manim';
import { store } from '../store';
import { btn, btnPrimary } from './ui';

export function ManimExport({ disabled }: { disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLTextAreaElement>(null);
  const [exported, setExported] = useState<ReturnType<typeof generateManim> | null>(null);
  const [status, setStatus] = useState('');

  function open() {
    setExported(generateManim(store.getState().project));
    setStatus('');
    dialog.current?.showModal();
  }

  async function copy() {
    if (!exported) return;
    try {
      await navigator.clipboard.writeText(exported.script);
      setStatus('Código copiado.');
    } catch {
      preview.current?.focus();
      preview.current?.select();
      setStatus('Código seleccionado. Pulsa Ctrl+C para copiarlo.');
    }
  }

  function download() {
    if (!exported) return;
    const url = URL.createObjectURL(new Blob([exported.script], { type: 'text/x-python;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'escena.py';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <>
      <button className={btn} disabled={disabled} onClick={open}>Exportar código Manim (.py)</button>
      <dialog ref={dialog} aria-labelledby="manim-title"
        className="studio-dialog w-[min(90vw,850px)]">
        <div className="flex items-center justify-between gap-3">
          <h2 id="manim-title" className="text-base font-semibold">Exportar código Manim</h2>
          <button className={btn} autoFocus onClick={() => dialog.current?.close()}>Cerrar</button>
        </div>
        {exported && (
          <>
            <p className="my-3 text-xs text-slate-300"><code>manim escena.py EscenaMathMotion</code></p>
            <textarea ref={preview} aria-label="Vista previa del código Python" value={exported.script} readOnly
              spellCheck={false} wrap="off" className="h-[46vh] w-full rounded-md border border-bezel bg-ink-950 p-3 font-mono text-xs" />
            {exported.notes.length > 0 && (
              <ul className="my-2 list-inside list-disc text-xs text-slate-300">
                {exported.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button className={btn} onClick={() => void copy()}>Copiar código</button>
              <button className={btnPrimary} onClick={download}>Descargar escena.py</button>
              <span role="status" className="text-xs text-slate-300">{status}</span>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
