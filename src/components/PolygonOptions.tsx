import { useLayoutEffect, useRef } from 'react';
import { regularPolygon } from '../engine/vector';
import { actions, store, useStore } from '../store';
import { btn, btnPrimary, Field, input } from './ui';

export function PolygonOptions() {
  const request = useStore((state) => state.ui.polygonRequest);
  const sides = useStore((state) => state.ui.polygonSides);
  const radius = useStore((state) => state.ui.polygonRadius);
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current!;
    if (request && !element.open) element.showModal();
    else if (!request && element.open) element.close();
  }, [request]);

  return (
    <dialog ref={dialog} aria-labelledby="polygon-title" className="studio-dialog w-[260px]"
      onClose={() => store.setUi({ polygonRequest: null })}>
      <form key={request ? String(request === 'options' ? request : `${request.x},${request.y}`) : 'closed'}
        className="space-y-2" onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          const count = Number(values.get('sides'));
          const length = Number(values.get('radius'));
          if (!Number.isInteger(count) || count < 3 || count > 20 || !Number.isFinite(length) || length < 1 || length > 5000) return;
          store.setUi({ polygonSides: count, polygonRadius: length, polygonRequest: null });
          if (request && request !== 'options') {
            const { bw, bh, vector } = regularPolygon(request, length, count);
            actions.addVector(vector, bw, bh, request);
          }
        }}>
        <h2 id="polygon-title" className="text-xs font-semibold">Polígono</h2>
        <Field label="Lados">
          <input className={`${input} w-24`} name="sides" type="number" min={3} max={20} step={1} defaultValue={sides} required autoFocus />
        </Field>
        <Field label="Radio (px)">
          <input className={`${input} w-24`} name="radius" type="number" min={1} max={5000} step="any" defaultValue={radius} required />
        </Field>
        <div className="flex justify-end gap-1">
          <button type="button" className={btn} onClick={() => dialog.current?.close()}>Cancelar</button>
          <button type="submit" className={btnPrimary}>{request === 'options' ? 'Aplicar' : 'Crear polígono'}</button>
        </div>
      </form>
    </dialog>
  );
}
