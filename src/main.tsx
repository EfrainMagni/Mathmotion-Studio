import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { startProjectAutosave } from './engine/projectStorage';
import { StageView } from './components/StageView';

const stageId = new URLSearchParams(window.location.search).get('stage');

// La ventana de grabación recibe su escena del editor y no modifica el autoguardado.
if (!stageId) await startProjectAutosave();

const root = createRoot(document.getElementById('root')!);
root.render(stageId ? <StageView sessionId={stageId} /> : <App />);
