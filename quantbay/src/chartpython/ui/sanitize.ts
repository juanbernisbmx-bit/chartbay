/**
 * Saneador de las salidas HTML del kernel (la tabla de un DataFrame, por
 * ejemplo) y de lo que traiga un `.ipynb` importado.
 *
 * Se arma un documento inerte con DOMParser —ahí nada se ejecuta ni se
 * descarga— y después se construyen nodos nuevos con `createElement` y
 * `createTextNode` copiando sólo lo permitido. Nunca se asigna `innerHTML`
 * sobre el documento vivo, así que un `<script>`, un `onerror=` o un
 * `href="javascript:"` no llegan a existir en la página.
 */
const ETIQUETAS = new Set([
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'div', 'dl', 'dt',
  'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'small',
  'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

/** Los elementos que se descartan con su contenido: nada de lo que traen sirve. */
const CON_CONTENIDO = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'link', 'meta', 'noscript', 'svg', 'math']);

const ATRIBUTOS: Record<string, string[]> = {
  a: ['href', 'title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  img: ['alt', 'title'],
};

const MAX_NODOS = 6000;
const ESQUEMAS = /^(https?:|mailto:)/i;

function atributoValido(etiqueta: string, nombre: string, valor: string): boolean {
  if (nombre === 'href') return ESQUEMAS.test(valor.trim());
  if (nombre === 'colspan' || nombre === 'rowspan' || nombre === 'span') return /^\d{1,3}$/.test(valor);
  if (nombre === 'scope') return ['row', 'col', 'rowgroup', 'colgroup'].includes(valor);
  return etiqueta === 'a' || etiqueta === 'img' ? valor.length <= 500 : false;
}

export function sanitizeHtml(html: string, doc: Document = document): DocumentFragment {
  const inerte = new DOMParser().parseFromString(html, 'text/html');
  const fragmento = doc.createDocumentFragment();
  let nodos = 0;
  let recortado = false;

  const copiar = (origen: Node, destino: Node): void => {
    for (const hijo of Array.from(origen.childNodes)) {
      if (nodos >= MAX_NODOS) { recortado = true; return; }
      if (hijo.nodeType === Node.TEXT_NODE) {
        destino.appendChild(doc.createTextNode(hijo.nodeValue ?? ''));
        nodos++;
        continue;
      }
      if (hijo.nodeType !== Node.ELEMENT_NODE) continue;
      const elemento = hijo as Element;
      const etiqueta = elemento.tagName.toLowerCase();
      if (CON_CONTENIDO.has(etiqueta)) continue;
      // Una etiqueta desconocida se descarta, pero su texto se conserva.
      if (!ETIQUETAS.has(etiqueta)) { copiar(elemento, destino); continue; }
      const nuevo = doc.createElement(etiqueta);
      nodos++;
      for (const nombre of ATRIBUTOS[etiqueta] ?? []) {
        const valor = elemento.getAttribute(nombre);
        if (valor !== null && atributoValido(etiqueta, nombre, valor)) nuevo.setAttribute(nombre, valor);
      }
      if (etiqueta === 'a') {
        // Un enlace de una salida puede apuntar a cualquier lado: se abre aparte
        // y sin pasarle la página que lo abrió.
        nuevo.setAttribute('rel', 'noopener noreferrer');
        nuevo.setAttribute('target', '_blank');
        if (!nuevo.hasAttribute('href')) { copiar(elemento, destino); continue; }
      }
      if (etiqueta === 'img') {
        // Las imágenes remotas quedan fuera (la CSP sólo permite el mismo
        // origen, data: y blob:), así que se muestra su texto alternativo.
        destino.appendChild(doc.createTextNode(elemento.getAttribute('alt') ?? ''));
        continue;
      }
      if (etiqueta === 'table') nuevo.className = 'cp-tabla';
      copiar(elemento, nuevo);
      destino.appendChild(nuevo);
    }
  };

  copiar(inerte.body, fragmento);
  if (recortado) {
    const aviso = doc.createElement('p');
    aviso.className = 'cp-aviso';
    aviso.textContent = '… salida recortada: demasiados elementos para mostrar.';
    fragmento.appendChild(aviso);
  }
  return fragmento;
}
