import { montar } from './app';

/** Entrada del bundle de la página /chartpython. */
async function iniciar(): Promise<void> {
  const raiz = document.querySelector<HTMLElement>('[data-chartpython]');
  if (!raiz) return;
  try {
    await montar(raiz);
  } catch (error) {
    const detalle = raiz.querySelector('#cp-detalle');
    if (detalle) detalle.textContent = `No se pudo abrir ChartPython: ${(error as Error).message}`;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void iniciar());
else void iniciar();
