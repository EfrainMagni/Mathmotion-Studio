import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { StageView } from './components/StageView';

const stageId = new URLSearchParams(window.location.search).get('stage');

// Sin StrictMode: el runtime del escenario es dueño de DOM y recursos WebGL, y su
// doble montaje de desarrollo crearía dos contextos innecesarios.
createRoot(document.getElementById('root')!).render(
  stageId ? (
    <StageView sessionId={stageId} />
  ) : (
    <App />
  ),
);
