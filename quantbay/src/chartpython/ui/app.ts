import { ChartPythonClient, ChartPythonKernelError } from '../client';
import type { KernelStatus, NotebookOutput } from '../protocol';
import {
  appendOutput, clearOutputs, indexOfCell, insertCell, moveCell, newCell, newNotebook, removeCell, touch,
  type Cell, type Notebook,
} from '../notebook/model';
import { nombreDeArchivo, parseIpynb, serializeIpynb } from '../notebook/ipynb';
import {
  abrir, borrarArchivo, borrarNotebook, guardarArchivo, guardarNotebook, leerNotebook, listarArchivos,
  listarNotebooks, recordarUltimo, ultimoNotebook,
} from '../notebook/storage';
import { construirEsqueleto } from './layout';
import { renderOutputs } from './outputs';
import { renderMarkdown } from './markdown';
import { ajustarAlto, manejarTecla } from './editor';
import { accionDeComando, accionDeEdicion, type Accion } from './shortcuts';

/**
 * La página de ChartPython: celdas, teclado en dos modos, archivos y guardado.
 * El estado de Python vive en el kernel de `client.ts`; acá se decide qué
 * ejecutar, se dibujan las salidas y se guarda todo en el navegador.
 *
 * Tres reglas ordenan el resto:
 *   1. Cada notebook tiene su propio intérprete: cambiar de notebook reinicia
 *      Python, porque si no las variables y los archivos del anterior seguirían
 *      vivos en el nuevo.
 *   2. Todo lo que llega tarde se descarta comparando el testigo con el que
 *      salió: una ejecución cancelada no escribe sobre la celda de otro.
 *   3. El kernel atiende una operación por vez, así que la cola es de acá y
 *      nada más la toca mientras corre (ni siquiera listar archivos).
 */
export const AVISO_DESCARGA = 'La primera ejecución descarga Python y sus paquetes (unos 115 MB). Queda en la caché del navegador para las próximas veces.';

export interface Dependencias {
  doc?: Document;
  cliente?: ChartPythonClient;
  db?: IDBDatabase | null;
}

type Modo = 'comando' | 'edicion';
type ResultadoGuardado = 'guardado' | 'sin-almacenamiento' | 'error';

export class ChartPythonApp {
  private doc: Document;
  private cliente: ChartPythonClient;
  private db: IDBDatabase | null;
  private notebook: Notebook = newNotebook();
  private seleccionada = '';
  private modo: Modo = 'comando';
  private pendiente = '';
  private borrada: { cell: Cell; index: number } | null = null;
  private cola: string[] = [];
  private corriendo = false;
  private enEjecucion = '';
  private testigo = 0;
  private kernelListo = false;
  private archivosSincronizados = false;
  private guardado: ReturnType<typeof setTimeout> | null = null;
  private cronometro: ReturnType<typeof setInterval> | null = null;
  private desdeStatus: (() => void) | null = null;

  constructor(private raiz: HTMLElement, deps: Dependencias = {}) {
    this.doc = deps.doc ?? raiz.ownerDocument ?? document;
    this.cliente = deps.cliente ?? new ChartPythonClient();
    this.db = deps.db ?? null;
  }

  private $<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.raiz.querySelector<T>(`#cp-${id}`) as T;
  }

  private estado(texto: string): void {
    this.$('detalle').textContent = texto;
  }

  async iniciar(): Promise<void> {
    construirEsqueleto(this.raiz, this.doc);
    this.$('aviso').textContent = AVISO_DESCARGA;
    if (!this.db) this.db = await abrir().catch(() => null);
    if (!this.db) this.estado('Este navegador no dejó abrir el almacenamiento local: vas a poder trabajar, pero nada se guarda solo. Descargá el .ipynb.');
    const guardado = this.db ? await this.recuperar() : null;
    this.notebook = guardado ?? newNotebook();
    this.seleccionada = this.notebook.cells[0]?.id ?? '';
    this.desdeStatus = this.cliente.onStatus(status => this.pintarEstado(status));
    this.conectar();
    await this.listarNotebooks();
    await this.pintarArchivos();
    this.pintar();
  }

  private async recuperar(): Promise<Notebook | null> {
    const id = ultimoNotebook();
    if (id && this.db) {
      const previo = await leerNotebook(this.db, id).catch(() => null);
      if (previo) return previo;
    }
    const lista = this.db ? await listarNotebooks(this.db).catch(() => []) : [];
    return lista.length && this.db ? leerNotebook(this.db, lista[0].id) : null;
  }

  // ─── Estado del kernel ─────────────────────────────────────────────────────

  private pintarEstado(status: KernelStatus): void {
    const etiquetas: Record<KernelStatus['state'], string> = {
      apagado: 'Python apagado', iniciando: 'Preparando Python…', listo: 'Python listo',
      ocupado: 'Ejecutando…', muerto: 'Python se detuvo',
    };
    const marcador = this.$('estado');
    marcador.textContent = etiquetas[status.state];
    marcador.dataset.estado = status.state;
    const arrancando = status.state === 'iniciando' && !this.kernelListo;
    if (status.state === 'listo') this.kernelListo = true;
    if (status.state === 'apagado' || status.state === 'muerto') {
      this.kernelListo = false;
      this.archivosSincronizados = false;
    }
    if (status.detail && status.state !== 'listo') this.estado(status.detail);
    this.$('memoria').textContent = status.memoryBytes
      ? `${Math.round(status.memoryBytes / 1024 / 1024)} MB de memoria`
      : '';
    this.$('aviso').hidden = !arrancando;
  }

  /**
   * Los archivos viven en IndexedDB porque el kernel los pierde al reiniciar.
   * Si en medio de la reposición cambia el notebook o se reinicia Python, se
   * corta: subir al kernel nuevo los archivos del anterior sería peor que nada.
   */
  private async prepararKernel(testigo: number): Promise<void> {
    if (this.archivosSincronizados || !this.db) return;
    const archivos = await listarArchivos(this.db, this.notebook.id).catch(() => []);
    const fallidos: string[] = [];
    for (const archivo of archivos) {
      if (testigo !== this.testigo) return;
      try {
        await this.cliente.upload(archivo.name, new Uint8Array(archivo.bytes));
      } catch {
        fallidos.push(archivo.name);
      }
    }
    if (testigo !== this.testigo) return;
    if (fallidos.length) {
      throw new Error(`No se pudieron poner en /mnt/data: ${fallidos.join(', ')}. La celda no se ejecutó para no trabajar con datos incompletos.`);
    }
    this.archivosSincronizados = true;
  }

  // ─── Ejecución ─────────────────────────────────────────────────────────────

  encolar(cellId: string): void {
    const celda = this.celda(cellId);
    if (!celda) return;
    if (celda.type !== 'code') {
      celda.outputs = [];
      this.pintarCelda(celda);
      return;
    }
    if (!this.cola.includes(cellId)) this.cola.push(cellId);
    this.pintarCelda(celda);
    void this.procesar();
  }

  private async procesar(): Promise<void> {
    if (this.corriendo) return;
    this.corriendo = true;
    let abandonada = false;
    while (this.cola.length) {
      const id = this.cola.shift()!;
      const celda = this.celda(id);
      if (!celda) continue;
      const testigo = this.testigo;
      this.enEjecucion = id;
      celda.outputs = [];
      celda.executionCount = null;
      this.pintarCelda(celda);
      this.arrancarCronometro();
      try {
        await this.prepararKernel(testigo);
        // Reponer archivos tarda: si mientras tanto se reinició o se cambió de
        // notebook, esta ejecución ya no corresponde a este kernel.
        if (testigo !== this.testigo) { abandonada = true; break; }
        const resultado = await this.cliente.execute(celda.source, salida => {
          if (testigo !== this.testigo) return;
          appendOutput(celda.outputs, salida);
          this.pintarSalidas(celda);
        });
        if (testigo !== this.testigo) { abandonada = true; break; }
        celda.outputs = resultado.outputs;
        celda.executionCount = resultado.executionCount;
      } catch (error) {
        if (testigo !== this.testigo) { abandonada = true; break; }
        celda.outputs = [this.salidaDeError(error)];
        this.cola = [];
      } finally {
        if (testigo === this.testigo) {
          this.enEjecucion = '';
          this.pararCronometro();
          this.pintarCelda(celda);
          this.guardar();
        }
      }
    }
    this.corriendo = false;
    if (abandonada) {
      // La cola puede tener ya celdas del notebook nuevo: las toma otra vuelta.
      this.enEjecucion = '';
      this.pararCronometro();
      if (this.cola.length) void this.procesar();
      return;
    }
    // Recién con la cola vacía se le puede preguntar al kernel por sus archivos:
    // atiende una operación por vez y estaría compitiendo con la próxima celda.
    if (this.kernelListo) {
      await this.pintarArchivos();
      this.estado('Listo.');
    }
  }

  private salidaDeError(error: unknown): NotebookOutput {
    const mensaje = error instanceof Error ? error.message : String(error);
    const codigo = error instanceof ChartPythonKernelError ? error.code : 'interfaz';
    this.estado(mensaje);
    return { output_type: 'error', ename: `ChartPython (${codigo})`, evalue: mensaje, traceback: [mensaje] };
  }

  private arrancarCronometro(): void {
    const desde = Date.now();
    this.pararCronometro();
    this.cronometro = setInterval(() => {
      this.$('reloj').textContent = `${Math.round((Date.now() - desde) / 1000)} s`;
    }, 250);
  }

  private pararCronometro(): void {
    if (this.cronometro) clearInterval(this.cronometro);
    this.cronometro = null;
    this.$('reloj').textContent = '';
  }

  ejecutarTodo(): void {
    for (const celda of this.notebook.cells) if (celda.type === 'code') this.encolar(celda.id);
  }

  interrumpir(mensaje = 'Se interrumpió la ejecución: Python volvió a arrancar y se perdieron las variables.'): void {
    this.cola = [];
    this.testigo++;
    this.enEjecucion = '';
    this.pararCronometro();
    this.cliente.restart();
    this.estado(mensaje);
    this.pintar();
  }

  reiniciar(): void {
    this.interrumpir('Python se reinició. Las celdas quedaron como estaban; volvé a ejecutarlas para recuperar las variables.');
  }

  // ─── Celdas ────────────────────────────────────────────────────────────────

  private celda(id: string): Cell | undefined {
    return this.notebook.cells.find(celda => celda.id === id);
  }

  /** Selección sin volver a dibujar: reconstruir mataría el textarea recién clickeado. */
  private marcarSeleccion(id: string): void {
    this.seleccionada = id;
    for (const nodo of Array.from(this.raiz.querySelectorAll<HTMLElement>('[data-celda]'))) {
      nodo.dataset.seleccionada = String(nodo.dataset.celda === id);
    }
  }

  private seleccionar(id: string, modo: Modo = this.modo): void {
    this.seleccionada = id;
    this.modo = modo;
    this.pintar();
    if (modo === 'edicion') this.raiz.querySelector<HTMLTextAreaElement>(`[data-celda="${id}"] textarea`)?.focus();
  }

  private mover(delta: number): void {
    const index = indexOfCell(this.notebook, this.seleccionada) + delta;
    const destino = this.notebook.cells[index];
    if (destino) this.seleccionar(destino.id);
  }

  ejecutarAccion(accion: Accion): void {
    const celda = this.celda(this.seleccionada);
    switch (accion) {
      case 'ejecutar': if (celda) this.encolar(celda.id); break;
      case 'ejecutar-y-seguir': {
        if (!celda) break;
        this.encolar(celda.id);
        const siguiente = this.notebook.cells[indexOfCell(this.notebook, celda.id) + 1];
        if (siguiente) this.seleccionar(siguiente.id, 'comando');
        else this.insertar('abajo', 'code');
        break;
      }
      case 'ejecutar-e-insertar': if (celda) { this.encolar(celda.id); this.insertar('abajo', 'code'); } break;
      case 'insertar-arriba': this.insertar('arriba', 'code'); break;
      case 'insertar-abajo': this.insertar('abajo', 'code'); break;
      case 'borrar': this.borrar(); break;
      case 'deshacer-borrado': this.deshacerBorrado(); break;
      case 'a-codigo': this.cambiarTipo('code'); break;
      case 'a-markdown': this.cambiarTipo('markdown'); break;
      case 'subir': if (celda && moveCell(this.notebook, celda.id, -1)) this.guardarYPintar(); break;
      case 'bajar': if (celda && moveCell(this.notebook, celda.id, 1)) this.guardarYPintar(); break;
      case 'anterior': this.mover(-1); break;
      case 'siguiente': this.mover(1); break;
      case 'editar': this.seleccionar(this.seleccionada, 'edicion'); break;
      case 'comando': this.modo = 'comando'; this.pintar(); break;
      case 'guardar': void this.escribirNotebook(); break;
      case 'reiniciar': this.reiniciar(); break;
      case 'interrumpir': this.interrumpir(); break;
    }
  }

  insertar(donde: 'arriba' | 'abajo', tipo: Cell['type']): Cell {
    const index = indexOfCell(this.notebook, this.seleccionada);
    const celda = insertCell(this.notebook, donde === 'arriba' ? index : index + 1, newCell(tipo));
    this.guardar();
    this.seleccionar(celda.id, 'edicion');
    return celda;
  }

  private borrar(): void {
    const borrada = removeCell(this.notebook, this.seleccionada);
    if (!borrada) return;
    this.borrada = borrada;
    const siguiente = this.notebook.cells[Math.min(borrada.index, this.notebook.cells.length - 1)];
    this.seleccionada = siguiente?.id ?? '';
    this.guardarYPintar();
    this.estado('Celda borrada. Con Z volvés atrás.');
  }

  private deshacerBorrado(): void {
    if (!this.borrada) return;
    insertCell(this.notebook, this.borrada.index, this.borrada.cell);
    this.seleccionada = this.borrada.cell.id;
    this.borrada = null;
    this.guardarYPintar();
  }

  private cambiarTipo(tipo: Cell['type']): void {
    const celda = this.celda(this.seleccionada);
    if (!celda || celda.type === tipo) return;
    celda.type = tipo;
    celda.outputs = [];
    celda.executionCount = null;
    this.guardarYPintar();
  }

  // ─── Notebooks ─────────────────────────────────────────────────────────────

  private tieneContenido(): boolean {
    return this.notebook.cells.some(celda => celda.source.trim() !== '' || celda.outputs.length > 0);
  }

  /**
   * Cambiar de notebook aísla el intérprete: se guarda el actual, se vacía la
   * cola, se reinicia Python y el testigo invalida lo que venga en camino.
   *
   * Si el guardado falla, no se cambia: reemplazar el notebook en memoria sería
   * perderlo sin siquiera poder exportarlo.
   */
  private async cambiarNotebook(cargar: () => Notebook | Promise<Notebook>, opciones: { guardarActual?: boolean } = {}): Promise<boolean> {
    if (opciones.guardarActual !== false) {
      const resultado = await this.escribirNotebook();
      if (resultado === 'error') {
        this.estado('No se cambió de notebook porque no se pudo guardar el actual. Descargá el .ipynb y probá de nuevo.');
        await this.listarNotebooks();
        return false;
      }
      if (resultado === 'sin-almacenamiento' && this.tieneContenido()
        && !this.doc.defaultView?.confirm('Este navegador no deja guardar notebooks. Si cambiás ahora perdés lo que escribiste. ¿Ya descargaste el .ipynb?')) {
        await this.listarNotebooks();
        return false;
      }
    }
    this.cola = [];
    this.testigo++;
    this.enEjecucion = '';
    this.pararCronometro();
    this.cliente.restart();
    this.archivosSincronizados = false;
    this.borrada = null;
    this.notebook = await cargar();
    this.seleccionada = this.notebook.cells[0]?.id ?? '';
    this.modo = 'comando';
    recordarUltimo(this.notebook.id);
    await this.listarNotebooks();
    await this.pintarArchivos();
    this.pintar();
    this.estado('Python se reinició al cambiar de notebook: cada uno tiene sus propias variables y archivos.');
    return true;
  }

  private guardarYPintar(): void {
    this.guardar();
    this.pintar();
  }

  /** Guardado con retardo mientras se escribe; los errores se muestran. */
  guardar(): void {
    touch(this.notebook);
    if (this.guardado) clearTimeout(this.guardado);
    this.guardado = setTimeout(() => void this.escribirNotebook(), 800);
  }

  async escribirNotebook(): Promise<ResultadoGuardado> {
    if (this.guardado) { clearTimeout(this.guardado); this.guardado = null; }
    const aviso = this.$('guardado');
    if (!this.db) {
      aviso.textContent = 'Sin guardar: el navegador no habilitó el almacenamiento. Descargá el .ipynb.';
      return 'sin-almacenamiento';
    }
    try {
      await guardarNotebook(this.db, this.notebook);
      recordarUltimo(this.notebook.id);
      aviso.textContent = `Guardado ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
      await this.listarNotebooks();
      return 'guardado';
    } catch (error) {
      aviso.textContent = `Sin guardar: ${(error as Error).message} Descargá el .ipynb para no perder el trabajo.`;
      return 'error';
    }
  }

  private async listarNotebooks(): Promise<void> {
    if (!this.db) return;
    const lista = await listarNotebooks(this.db).catch(() => []);
    const select = this.$<HTMLSelectElement>('notebooks');
    select.replaceChildren();
    for (const resumen of lista) {
      const opcion = this.doc.createElement('option');
      opcion.value = resumen.id;
      opcion.textContent = `${resumen.name} · ${resumen.celdas} celdas`;
      opcion.selected = resumen.id === this.notebook.id;
      select.appendChild(opcion);
    }
  }

  async abrirNotebook(id: string): Promise<void> {
    if (!this.db || id === this.notebook.id) return;
    await this.cambiarNotebook(async () => (await leerNotebook(this.db!, id)) ?? newNotebook());
  }

  async nuevoNotebook(nombre = 'Notebook sin título'): Promise<void> {
    if (await this.cambiarNotebook(() => newNotebook(nombre))) await this.escribirNotebook();
  }

  /** Recibe el contenido ya leído: abrir el archivo es tarea del input. */
  async importar(nombre: string, contenido: string): Promise<void> {
    const notebook = parseIpynb(contenido, nombre.replace(/\.ipynb$/i, ''));
    if (!await this.cambiarNotebook(() => notebook)) return;
    await this.escribirNotebook();
    this.estado(`Se abrió ${nombre}. Las salidas que trae son del archivo: ejecutá las celdas para regenerarlas.`);
  }

  exportar(): void {
    this.descargar(new Blob([serializeIpynb(this.notebook)], { type: 'application/x-ipynb+json' }), nombreDeArchivo(this.notebook));
  }

  private descargar(blob: Blob, nombre: string): void {
    const url = URL.createObjectURL(blob);
    const enlace = this.doc.createElement('a');
    enlace.href = url;
    enlace.download = nombre;
    enlace.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  private async borrarActual(): Promise<void> {
    if (!this.db) return;
    if (!this.doc.defaultView?.confirm(`¿Borrar "${this.notebook.name}" de este navegador?`)) return;
    const id = this.notebook.id;
    const lista = (await listarNotebooks(this.db)).filter(resumen => resumen.id !== id);
    // Se está borrando a propósito: no tiene sentido guardarlo antes.
    await this.cambiarNotebook(
      async () => (lista.length ? (await leerNotebook(this.db!, lista[0].id)) ?? newNotebook() : newNotebook()),
      { guardarActual: false },
    );
    await borrarNotebook(this.db, id);
    await this.listarNotebooks();
  }

  // ─── Archivos ──────────────────────────────────────────────────────────────

  async subirArchivo(nombre: string, bytes: ArrayBuffer): Promise<void> {
    if (this.db) await guardarArchivo(this.db, this.notebook.id, nombre, bytes);
    // Con el kernel ocupado no se le habla: queda para la reposición previa a
    // la próxima celda, que es justo lo que hace prepararKernel.
    if (this.kernelListo && !this.corriendo && !this.cliente.busy) {
      await this.cliente.upload(nombre, new Uint8Array(bytes));
    } else {
      this.archivosSincronizados = false;
    }
    await this.pintarArchivos();
    this.estado(`${nombre} quedó en /mnt/data: abrilo con pd.read_csv("${nombre}").`);
  }

  /** Lista lo subido y lo que haya escrito Python; el kernel manda en el tamaño. */
  private async pintarArchivos(): Promise<void> {
    const lista = this.$('archivos');
    if (!lista) return;
    const guardados = this.db ? await listarArchivos(this.db, this.notebook.id).catch(() => []) : [];
    const puedoPreguntar = this.kernelListo && !this.corriendo && !this.cliente.busy;
    const delKernel = puedoPreguntar ? await this.cliente.listFiles().catch(() => []) : [];
    const filas = new Map<string, { size: number; guardado: boolean; enKernel: boolean }>();
    for (const archivo of guardados) filas.set(archivo.name, { size: archivo.size, guardado: true, enKernel: false });
    for (const archivo of delKernel) {
      const previo = filas.get(archivo.name);
      filas.set(archivo.name, { size: archivo.size, guardado: previo?.guardado ?? false, enKernel: true });
    }
    lista.replaceChildren();
    for (const [nombre, info] of [...filas.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const item = this.doc.createElement('li');
      const etiqueta = this.doc.createElement('span');
      const origen = info.guardado ? 'subido' : 'creado por Python';
      etiqueta.textContent = `${nombre} · ${Math.max(1, Math.round(info.size / 1024))} KB · ${origen}`;
      item.appendChild(etiqueta);
      if (info.enKernel) {
        const bajar = this.doc.createElement('button');
        bajar.type = 'button';
        bajar.className = 'btn-ink';
        bajar.textContent = 'Descargar';
        bajar.addEventListener('click', () => void this.descargarDelKernel(nombre));
        item.appendChild(bajar);
      }
      if (info.guardado) {
        const quitar = this.doc.createElement('button');
        quitar.type = 'button';
        quitar.className = 'btn-ink';
        quitar.textContent = 'Quitar';
        quitar.addEventListener('click', () => void this.quitarArchivo(nombre));
        item.appendChild(quitar);
      }
      lista.appendChild(item);
    }
  }

  private async descargarDelKernel(nombre: string): Promise<void> {
    if (this.corriendo || this.cliente.busy) {
      this.estado('Python está ocupado: probá de nuevo cuando termine la celda.');
      return;
    }
    try {
      const bytes = await this.cliente.download(nombre);
      // `slice()` copia a un ArrayBuffer propio: el que devuelve el worker
      // puede ser una vista sobre otro más grande.
      this.descargar(new Blob([bytes.slice().buffer as ArrayBuffer]), nombre);
    } catch (error) {
      this.estado(`No se pudo descargar ${nombre}: ${(error as Error).message}`);
    }
  }

  private async quitarArchivo(name: string): Promise<void> {
    if (this.db) await borrarArchivo(this.db, this.notebook.id, name);
    await this.pintarArchivos();
    this.estado(`${name} ya no se repone al reiniciar Python. Si Python lo tiene abierto, sigue ahí hasta el próximo reinicio.`);
  }

  // ─── Dibujo ────────────────────────────────────────────────────────────────

  private pintarSalidas(celda: Cell): void {
    const destino = this.raiz.querySelector<HTMLElement>(`[data-celda="${celda.id}"] .cp-salidas`);
    if (!destino) return;
    destino.replaceChildren(renderOutputs(celda.outputs, this.doc));
  }

  private pintarCelda(celda: Cell): void {
    const nodo = this.raiz.querySelector<HTMLElement>(`[data-celda="${celda.id}"]`);
    if (!nodo) { this.pintar(); return; }
    const prompt = nodo.querySelector<HTMLElement>('.cp-prompt-in');
    if (prompt) prompt.textContent = this.textoPrompt(celda);
    nodo.dataset.corriendo = String(this.enEjecucion === celda.id);
    this.pintarSalidas(celda);
  }

  private textoPrompt(celda: Cell): string {
    if (celda.type !== 'code') return '';
    if (this.enEjecucion === celda.id || this.cola.includes(celda.id)) return 'In [*]:';
    return celda.executionCount ? `In [${celda.executionCount}]:` : 'In [ ]:';
  }

  pintar(): void {
    const contenedor = this.$('celdas');
    contenedor.replaceChildren();
    for (const celda of this.notebook.cells) contenedor.appendChild(this.nodoDeCelda(celda));
    this.$('nombre').textContent = this.notebook.name;
    this.raiz.dataset.modo = this.modo;
  }

  private nodoDeCelda(celda: Cell): HTMLElement {
    const nodo = this.doc.createElement('div');
    nodo.className = 'cp-celda';
    nodo.dataset.celda = celda.id;
    nodo.dataset.tipo = celda.type;
    nodo.dataset.seleccionada = String(celda.id === this.seleccionada);
    nodo.dataset.corriendo = String(this.enEjecucion === celda.id);
    nodo.addEventListener('mousedown', () => this.marcarSeleccion(celda.id));

    const prompt = this.doc.createElement('div');
    prompt.className = 'cp-prompt cp-prompt-in';
    prompt.textContent = this.textoPrompt(celda);
    nodo.appendChild(prompt);

    const cuerpo = this.doc.createElement('div');
    cuerpo.className = 'cp-cuerpo';

    const editando = celda.id === this.seleccionada && this.modo === 'edicion';
    if (celda.type === 'markdown' && !editando) {
      const vista = this.doc.createElement('div');
      vista.className = 'cp-markdown';
      vista.appendChild(renderMarkdown(celda.source || '*Celda de texto vacía: Enter para editarla.*', this.doc));
      vista.addEventListener('dblclick', () => this.seleccionar(celda.id, 'edicion'));
      cuerpo.appendChild(vista);
    } else {
      const area = this.doc.createElement('textarea');
      area.className = 'cp-codigo';
      area.spellcheck = false;
      area.value = celda.source;
      area.setAttribute('aria-label', celda.type === 'code' ? 'Código de la celda' : 'Texto de la celda');
      area.addEventListener('input', () => { celda.source = area.value; ajustarAlto(area); this.guardar(); });
      area.addEventListener('focus', () => { this.marcarSeleccion(celda.id); this.modo = 'edicion'; this.raiz.dataset.modo = 'edicion'; });
      area.addEventListener('keydown', evento => this.teclaEnEditor(evento, area));
      cuerpo.appendChild(area);
      setTimeout(() => ajustarAlto(area), 0);
    }

    const salidas = this.doc.createElement('div');
    salidas.className = 'cp-salidas';
    salidas.appendChild(renderOutputs(celda.outputs, this.doc));
    cuerpo.appendChild(salidas);
    nodo.appendChild(cuerpo);
    return nodo;
  }

  private teclaEnEditor(evento: KeyboardEvent, area: HTMLTextAreaElement): void {
    const accion = accionDeEdicion(evento);
    if (accion) {
      evento.preventDefault();
      const celda = this.celda(this.seleccionada);
      if (celda) celda.source = area.value;
      if (accion === 'comando') { area.blur(); this.modo = 'comando'; this.pintar(); return; }
      this.ejecutarAccion(accion);
      if (accion.startsWith('ejecutar')) { area.blur(); this.modo = 'comando'; }
      return;
    }
    if (manejarTecla(area, evento)) {
      evento.preventDefault();
      const celda = this.celda(this.seleccionada);
      if (celda) { celda.source = area.value; this.guardar(); }
    }
  }

  // ─── Conexión con la página ────────────────────────────────────────────────

  private conectar(): void {
    const boton = (id: string, accion: () => void): void => { this.$(id)?.addEventListener('click', accion); };
    boton('agregar-codigo', () => this.insertar('abajo', 'code'));
    boton('agregar-markdown', () => this.insertar('abajo', 'markdown'));
    boton('ejecutar', () => this.ejecutarAccion('ejecutar-y-seguir'));
    boton('ejecutar-todo', () => this.ejecutarTodo());
    boton('interrumpir', () => this.interrumpir());
    boton('reiniciar', () => this.reiniciar());
    boton('limpiar', () => { clearOutputs(this.notebook); this.guardarYPintar(); });
    boton('nuevo', () => void this.nuevoNotebook());
    boton('exportar', () => this.exportar());
    boton('renombrar', () => {
      const nombre = this.doc.defaultView?.prompt('Nombre del notebook', this.notebook.name);
      if (nombre) { this.notebook.name = nombre.slice(0, 120); void this.escribirNotebook(); this.pintar(); }
    });
    boton('borrar-notebook', () => void this.borrarActual());

    this.$<HTMLSelectElement>('notebooks').addEventListener('change', evento => {
      void this.abrirNotebook((evento.target as HTMLSelectElement).value);
    });
    const fallo = (error: unknown): void => this.estado(String((error as Error)?.message ?? error));
    this.$<HTMLInputElement>('importar').addEventListener('change', evento => {
      const entrada = evento.target as HTMLInputElement;
      const archivo = entrada.files?.[0];
      entrada.value = '';
      if (!archivo) return;
      void archivo.text().then(contenido => this.importar(archivo.name, contenido)).catch(fallo);
    });
    this.$<HTMLInputElement>('subir').addEventListener('change', evento => {
      const entrada = evento.target as HTMLInputElement;
      const archivo = entrada.files?.[0];
      entrada.value = '';
      if (!archivo) return;
      void archivo.arrayBuffer().then(bytes => this.subirArchivo(archivo.name, bytes)).catch(fallo);
    });

    this.doc.addEventListener('keydown', evento => this.teclaGlobal(evento));
    this.doc.defaultView?.addEventListener('pagehide', () => this.cliente.dispose());
  }

  private teclaGlobal(evento: KeyboardEvent): void {
    const destino = evento.target as HTMLElement | null;
    const etiqueta = destino?.tagName;
    if (etiqueta === 'TEXTAREA' || etiqueta === 'INPUT' || etiqueta === 'SELECT') return;
    const { accion, pendiente } = accionDeComando(evento, this.pendiente);
    this.pendiente = pendiente;
    if (!accion) return;
    evento.preventDefault();
    this.ejecutarAccion(accion);
  }

  destruir(): void {
    this.desdeStatus?.();
    this.pararCronometro();
    if (this.guardado) clearTimeout(this.guardado);
    this.cliente.dispose();
  }
}

export async function montar(raiz: HTMLElement, deps: Dependencias = {}): Promise<ChartPythonApp> {
  const app = new ChartPythonApp(raiz, deps);
  await app.iniciar();
  return app;
}
