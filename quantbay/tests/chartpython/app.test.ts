import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { montar, type ChartPythonApp } from '../../src/chartpython/ui/app';
import { abrir } from '../../src/chartpython/notebook/storage';
import type { ChartPythonClient } from '../../src/chartpython/client';
import { ChartPythonKernelError, type ExecutionResult, type KernelFile, type KernelStatus, type NotebookOutput } from '../../src/chartpython/protocol';

/** Kernel de mentira: registra lo que la interfaz le pide y responde al instante. */
class ClienteFalso {
  private oyentes: ((status: KernelStatus) => void)[] = [];
  estado: KernelStatus = { state: 'apagado' };
  ejecutado: string[] = [];
  subidos: string[] = [];
  listados = 0;
  reinicios = 0;
  cuenta = 0;
  busy = false;
  falla: ChartPythonKernelError | null = null;
  demora = 0;

  onStatus(callback: (status: KernelStatus) => void): () => void {
    this.oyentes.push(callback);
    callback(this.estado);
    return () => { this.oyentes = this.oyentes.filter(o => o !== callback); };
  }
  private emitir(estado: KernelStatus): void {
    this.estado = estado;
    for (const oyente of this.oyentes) oyente(estado);
  }
  async warmup(): Promise<void> { this.emitir({ state: 'listo' }); }
  async execute(code: string, onOutput?: (salida: NotebookOutput) => void): Promise<ExecutionResult> {
    this.busy = true;
    this.emitir({ state: 'listo', memoryBytes: 80 * 1024 * 1024 });
    if (this.demora) await new Promise(resolve => setTimeout(resolve, this.demora));
    this.busy = false;
    if (this.falla) throw this.falla;
    this.ejecutado.push(code);
    this.cuenta += 1;
    onOutput?.({ output_type: 'stream', name: 'stdout', text: 'hola\n' });
    return {
      executionCount: this.cuenta,
      status: 'ok',
      outputs: [
        { output_type: 'stream', name: 'stdout', text: 'hola\n' },
        { output_type: 'execute_result', execution_count: this.cuenta, data: { 'text/plain': '42' }, metadata: {} },
      ],
    };
  }
  async upload(name: string): Promise<string> { this.subidos.push(name); return `/mnt/data/${name}`; }
  async listFiles(): Promise<KernelFile[]> { this.listados += 1; return []; }
  async download(): Promise<Uint8Array> { return new Uint8Array([1, 2, 3]); }
  restart(): void { this.reinicios += 1; this.cuenta = 0; this.emitir({ state: 'apagado' }); }
  dispose(): void {}
}

const apps: ChartPythonApp[] = [];
const bases: IDBDatabase[] = [];
/** Base propia por test: si no, el notebook de uno reaparece en el siguiente. */
async function montarApp(cliente = new ClienteFalso()): Promise<{ app: ChartPythonApp; raiz: HTMLElement; cliente: ClienteFalso }> {
  const raiz = document.createElement('div');
  document.body.appendChild(raiz);
  const db = await abrir('chartpython-test-' + crypto.randomUUID());
  bases.push(db);
  const app = await montar(raiz, { cliente: cliente as unknown as ChartPythonClient, db });
  apps.push(app);
  return { app, raiz, cliente };
}
async function esperar(condicion: () => boolean, mensaje = 'no pasó a tiempo'): Promise<void> {
  for (let intento = 0; intento < 100; intento++) {
    if (condicion()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(mensaje);
}
const escribir = (raiz: HTMLElement, texto: string): void => {
  const area = raiz.querySelector('textarea') as HTMLTextAreaElement;
  area.value = texto;
  area.dispatchEvent(new Event('input'));
};

afterEach(() => {
  for (const app of apps.splice(0)) app.destruir();
  for (const db of bases.splice(0)) db.close();
  document.body.replaceChildren();
  localStorage.clear();
});

describe('la página de ChartPython', () => {
  it('ejecuta una celda y muestra la salida con su número', async () => {
    const { app, raiz, cliente } = await montarApp();
    escribir(raiz, 'print("hola")\n42');
    app.ejecutarAccion('ejecutar');
    await esperar(() => raiz.textContent?.includes('42') ?? false);
    expect(cliente.ejecutado).toEqual(['print("hola")\n42']);
    expect(raiz.querySelector('.cp-prompt-in')?.textContent).toBe('In [1]:');
    expect(raiz.querySelector('.cp-flujo')?.textContent).toBe('hola\n');
    expect(raiz.textContent).toContain('Out[1]:');
  });

  it('un error del kernel se ve en la celda y frena la cola', async () => {
    const cliente = new ClienteFalso();
    cliente.falla = new ChartPythonKernelError('worker-crashed', 'El proceso de Python se detuvo.');
    const { app, raiz } = await montarApp(cliente);
    escribir(raiz, 'x = 1');
    app.ejecutarAccion('ejecutar');
    await esperar(() => raiz.querySelector('.cp-error') !== null);
    expect(raiz.querySelector('.cp-error')?.textContent).toContain('El proceso de Python se detuvo.');
  });

  it('cambiar de notebook reinicia Python para no arrastrar variables', async () => {
    const { app, raiz, cliente } = await montarApp();
    escribir(raiz, 'x = 1');
    app.ejecutarAccion('ejecutar');
    await esperar(() => cliente.ejecutado.length === 1);
    await app.nuevoNotebook('Otro');
    expect(cliente.reinicios).toBeGreaterThanOrEqual(1);
    expect(raiz.querySelector('textarea')?.value).toBe('');
    expect(raiz.querySelector('.cp-prompt-in')?.textContent).toBe('In [ ]:');
  });

  it('no le pide archivos al kernel mientras corre una celda', async () => {
    const cliente = new ClienteFalso();
    cliente.demora = 30;
    const { app, raiz } = await montarApp(cliente);
    const listadosAntes = cliente.listados;
    escribir(raiz, 'a = 1');
    app.ejecutarAccion('ejecutar');
    app.ejecutarTodo();
    expect(cliente.listados).toBe(listadosAntes);
    await esperar(() => cliente.ejecutado.length >= 1 && !cliente.busy);
    await esperar(() => cliente.listados > listadosAntes, 'nunca refrescó los archivos al vaciarse la cola');
  });

  it('abre un .ipynb y muestra sus celdas sin ejecutarlas', async () => {
    const { app, raiz, cliente } = await montarApp();
    const contenido = JSON.stringify({
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# Trabajo práctico\n'] },
        { cell_type: 'code', metadata: {}, execution_count: 7, outputs: [], source: ['import pandas as pd\n'] },
      ],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    });
    await app.importar('tp.ipynb', contenido);
    expect(raiz.querySelector('.cp-markdown h1')?.textContent).toBe('Trabajo práctico');
    expect(raiz.querySelectorAll('.cp-celda')).toHaveLength(2);
    expect(cliente.ejecutado).toHaveLength(0);
  });

  it('las celdas de texto se dibujan como markdown y vuelven a código vacías', async () => {
    const { app, raiz } = await montarApp();
    escribir(raiz, '## Hola');
    app.ejecutarAccion('a-markdown');
    expect(raiz.querySelector('.cp-markdown h2')?.textContent).toBe('Hola');
    app.ejecutarAccion('a-codigo');
    expect(raiz.querySelector('textarea')?.value).toBe('## Hola');
  });

  it('interrumpir vacía la cola y avisa que se perdieron las variables', async () => {
    const cliente = new ClienteFalso();
    cliente.demora = 50;
    const { app, raiz } = await montarApp(cliente);
    escribir(raiz, 'import time');
    app.ejecutarAccion('ejecutar');
    app.interrumpir();
    expect(cliente.reinicios).toBe(1);
    expect(raiz.querySelector('#cp-detalle')?.textContent).toContain('se perdieron las variables');
  });
});
