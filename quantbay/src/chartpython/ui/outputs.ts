import { renderMarkdown } from './markdown';
import { sanitizeHtml } from './sanitize';
import type { NotebookOutput } from '../protocol';

/** Igual que Jupyter: se muestra la representación más rica que haya. */
const PREFERENCIA = ['image/png', 'image/svg+xml', 'text/html', 'text/markdown', 'text/plain'];

function imagen(mime: string, contenido: string, doc: Document): HTMLImageElement {
  const img = doc.createElement('img');
  img.className = 'cp-imagen';
  img.alt = 'Salida de la celda';
  // Un SVG dentro de <img> no ejecuta scripts ni pide recursos externos, y la
  // CSP del sitio sólo admite data: y blob: para imágenes.
  img.src = mime === 'image/png'
    ? `data:image/png;base64,${contenido.replace(/\s+/g, '')}`
    : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(contenido)}`;
  return img;
}

export function renderOutput(output: NotebookOutput, doc: Document = document): HTMLElement {
  const caja = doc.createElement('div');
  caja.className = 'cp-salida';

  if (output.output_type === 'stream') {
    const pre = doc.createElement('pre');
    pre.className = output.name === 'stderr' ? 'cp-flujo cp-stderr' : 'cp-flujo';
    pre.textContent = output.text;
    caja.appendChild(pre);
    return caja;
  }

  if (output.output_type === 'error') {
    const pre = doc.createElement('pre');
    pre.className = 'cp-error';
    pre.textContent = output.traceback.length
      ? output.traceback.join('\n')
      : `${output.ename}: ${output.evalue}`;
    caja.appendChild(pre);
    return caja;
  }

  if (output.output_type === 'execute_result') {
    const prompt = doc.createElement('span');
    prompt.className = 'cp-prompt cp-prompt-out';
    prompt.textContent = `Out[${output.execution_count}]:`;
    caja.appendChild(prompt);
  }

  const mime = PREFERENCIA.find(tipo => tipo in output.data) ?? 'text/plain';
  const contenido = output.data[mime] ?? '';
  const cuerpo = doc.createElement('div');
  cuerpo.className = 'cp-valor';
  if (mime === 'image/png' || mime === 'image/svg+xml') cuerpo.appendChild(imagen(mime, contenido, doc));
  else if (mime === 'text/html') cuerpo.appendChild(sanitizeHtml(contenido, doc));
  else if (mime === 'text/markdown') cuerpo.appendChild(renderMarkdown(contenido, doc));
  else {
    const pre = doc.createElement('pre');
    pre.className = 'cp-flujo';
    pre.textContent = contenido;
    cuerpo.appendChild(pre);
  }
  caja.appendChild(cuerpo);
  return caja;
}

export function renderOutputs(outputs: NotebookOutput[], doc: Document = document): DocumentFragment {
  const fragmento = doc.createDocumentFragment();
  for (const output of outputs) fragmento.appendChild(renderOutput(output, doc));
  return fragmento;
}
