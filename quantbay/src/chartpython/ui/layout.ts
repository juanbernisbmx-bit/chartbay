/**
 * El esqueleto de la página se arma acá y no en la plantilla Jinja: así la
 * prueba de la interfaz monta lo mismo que el navegador y no hay una lista de
 * ids repartida entre HTML y TypeScript que se desincronice.
 */
export interface Esqueleto { raiz: HTMLElement }

interface DefinicionBoton { id: string; texto: string; titulo?: string }

const HERRAMIENTAS: DefinicionBoton[] = [
  { id: 'ejecutar', texto: '▶ Ejecutar', titulo: 'Shift+Enter' },
  { id: 'ejecutar-todo', texto: '⏭ Ejecutar todo' },
  { id: 'interrumpir', texto: '■ Interrumpir', titulo: 'Detiene la ejecución reiniciando Python (I, I)' },
  { id: 'reiniciar', texto: '↻ Reiniciar', titulo: 'Borra las variables (0, 0)' },
  { id: 'agregar-codigo', texto: '+ Código', titulo: 'B' },
  { id: 'agregar-markdown', texto: '+ Texto', titulo: 'M' },
  { id: 'limpiar', texto: 'Borrar salidas' },
];

const NOTEBOOK: DefinicionBoton[] = [
  { id: 'nuevo', texto: 'Nuevo' },
  { id: 'renombrar', texto: 'Renombrar' },
  { id: 'exportar', texto: 'Descargar .ipynb' },
  { id: 'borrar-notebook', texto: 'Borrar' },
];

function boton(doc: Document, { id, texto, titulo }: DefinicionBoton): HTMLButtonElement {
  const elemento = doc.createElement('button');
  elemento.type = 'button';
  elemento.id = `cp-${id}`;
  elemento.className = 'btn-ink';
  elemento.textContent = texto;
  if (titulo) elemento.title = titulo;
  return elemento;
}

function archivo(doc: Document, id: string, etiqueta: string, accept: string): HTMLLabelElement {
  const label = doc.createElement('label');
  label.className = 'cp-archivo';
  label.textContent = etiqueta;
  const entrada = doc.createElement('input');
  entrada.type = 'file';
  entrada.id = `cp-${id}`;
  entrada.accept = accept;
  label.appendChild(entrada);
  return label;
}

function texto(doc: Document, id: string, className: string, contenido = ''): HTMLElement {
  const elemento = doc.createElement('span');
  elemento.id = `cp-${id}`;
  elemento.className = className;
  elemento.textContent = contenido;
  return elemento;
}

export function construirEsqueleto(raiz: HTMLElement, doc: Document = raiz.ownerDocument ?? document): void {
  raiz.replaceChildren();

  const barraNotebook = doc.createElement('div');
  barraNotebook.className = 'cp-barra';
  const select = doc.createElement('select');
  select.id = 'cp-notebooks';
  select.setAttribute('aria-label', 'Notebooks guardados en este navegador');
  barraNotebook.append(select, ...NOTEBOOK.map(definicion => boton(doc, definicion)),
    archivo(doc, 'importar', 'Abrir .ipynb', '.ipynb,application/x-ipynb+json'));

  const barraCeldas = doc.createElement('div');
  barraCeldas.className = 'cp-barra';
  barraCeldas.append(...HERRAMIENTAS.map(definicion => boton(doc, definicion)));

  const aviso = doc.createElement('p');
  aviso.id = 'cp-aviso';
  aviso.className = 'cp-aviso';
  aviso.hidden = true;

  const celdas = doc.createElement('div');
  celdas.id = 'cp-celdas';
  celdas.className = 'cp-celdas';

  const archivos = doc.createElement('section');
  archivos.className = 'cp-archivos';
  const tituloArchivos = doc.createElement('h3');
  tituloArchivos.className = 'qb-subtitle';
  tituloArchivos.textContent = 'Archivos del notebook';
  const ayudaArchivos = doc.createElement('p');
  ayudaArchivos.className = 'qb-help';
  ayudaArchivos.textContent = 'Lo que subas queda en /mnt/data, la carpeta donde arranca Python: abrilo con pd.read_csv("archivo.csv"). Se guarda en este navegador y se repone cuando Python se reinicia.';
  const lista = doc.createElement('ul');
  lista.id = 'cp-archivos';
  lista.className = 'cp-lista-archivos';
  archivos.append(tituloArchivos, archivo(doc, 'subir', 'Subir archivo', '.csv,.txt,.json,.tsv,.xlsx'), lista, ayudaArchivos);

  const estado = doc.createElement('div');
  estado.className = 'cp-estado';
  estado.append(
    texto(doc, 'estado', 'cp-kernel', 'Python apagado'),
    texto(doc, 'detalle', 'cp-detalle'),
    texto(doc, 'reloj', 'cp-reloj'),
    texto(doc, 'memoria', 'cp-memoria'),
    texto(doc, 'guardado', 'cp-guardado'),
    texto(doc, 'nombre', 'cp-nombre'),
  );

  raiz.append(barraNotebook, barraCeldas, aviso, celdas, archivos, estado);
}
