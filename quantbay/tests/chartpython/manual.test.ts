import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PythonRuntime, type PythonEngine } from '../../src/chartpython/pythonRuntime';
import type { NotebookOutput } from '../../src/chartpython/protocol';

/**
 * El manual de ChartPython promete que cada ejemplo funciona en ChartPython.
 * Esta prueba lo cumple: toma los bloques de la plantilla en orden y los ejecuta
 * en un único intérprete con el Pyodide vendorizado, como alguien que los copia
 * uno por uno en un notebook nuevo. Falla si un ejemplo da error (o deja de
 * darlo cuando debe), si imprime un aviso que el manual no menciona o si su
 * salida ya no coincide con la que muestra la página.
 *
 * Con MANUAL_SALIDAS=/ruta/salidas.json guarda lo que devolvió cada bloque, para
 * escribir las salidas nuevas sin copiarlas a mano.
 */
const require = createRequire(import.meta.url);
const PLANTILLA = resolve(process.cwd(), '../web/templates/chartpython_manual.html');

type Macro = 'py' | 'salida' | 'salida_error';
interface Bloque { macro: Macro; opciones: Record<string, string | boolean>; texto: string; linea: number }

// La misma expresión que web/chartpython_manual.py, que arma el notebook.
const BLOQUE = /\{%-?\s*call\s+(py|salida|salida_error)\(([^)]*)\)\s*-?%\}([\s\S]*?)\{%-?\s*endcall\s*-?%\}/g;
const OPCION = /(\w+)\s*=\s*(?:"([^"]*)"|(true|false))/g;

function extraer(fuente: string): Bloque[] {
  return [...fuente.matchAll(BLOQUE)].map(m => ({
    macro: m[1] as Macro,
    opciones: Object.fromEntries([...m[2].matchAll(OPCION)].map(o => [o[1], o[3] ? o[3] === 'true' : o[2]])),
    texto: m[3],
    linea: fuente.slice(0, m.index).split('\n').length,
  }));
}

/** Igual que los macros de la plantilla: el código sin bordes, la salida sin sus líneas vacías de afuera. */
const codigo = (bloque: Bloque): string => bloque.texto.trim();
const normalizar = (texto: string): string => texto.replace(/^\n+/, '').split('\n').map(linea => linea.trimEnd()).join('\n').trimEnd();

interface Resultado { status: 'ok' | 'error'; texto: string; avisos: string; error: string }

function resumir(status: 'ok' | 'error', outputs: NotebookOutput[]): Resultado {
  let texto = '', avisos = '', error = '';
  for (const salida of outputs) {
    if (salida.output_type === 'stream') {
      if (salida.name === 'stderr') avisos += salida.text;
      else texto += salida.text;
    } else if (salida.output_type === 'error') {
      error = `${salida.ename}: ${salida.evalue}`;
    } else {
      texto += (salida.data['text/plain'] ?? '') + '\n';
    }
  }
  return { status, texto: normalizar(texto), avisos, error: normalizar(error) };
}

const fuente = readFileSync(PLANTILLA, 'utf8');
const bloques = extraer(fuente);

describe('estructura de los ejemplos del manual', () => {
  it('encuentra los bloques y ninguno se come la sintaxis de Jinja', () => {
    expect(bloques.filter(b => b.macro === 'py').length).toBeGreaterThan(100);
    for (const bloque of bloques) {
      expect(bloque.texto, `línea ${bloque.linea}`).not.toMatch(/\{\{|\{%|\{#/);
      expect(codigo(bloque), `línea ${bloque.linea}: bloque vacío`).not.toBe('');
    }
  });

  it('cada salida sigue a un ejemplo del tipo que corresponde', () => {
    bloques.forEach((bloque, i) => {
      if (bloque.macro === 'py') return;
      const previo = bloques[i - 1];
      expect(previo?.macro, `línea ${bloque.linea}: salida sin ejemplo antes`).toBe('py');
      expect(Boolean(previo.opciones.error), `línea ${bloque.linea}`).toBe(bloque.macro === 'salida_error');
    });
  });
});

// Las dos pasadas comparten un Pyodide: cargarlo de nuevo cuesta segundos y
// memoria, y para empezar de cero alcanza con un PythonRuntime nuevo (otro
// espacio de nombres), /mnt/data vacío y las opciones de visualización de
// pandas en sus valores por defecto.
let pyodide: PythonEngine | null = null;

async function pythonNuevo(): Promise<PythonRuntime> {
  if (!pyodide) {
    const dir = resolve(process.cwd(), '../web/static/vendor/pyodide/0.26.4');
    const { loadPyodide } = require(resolve(dir, 'pyodide.js'));
    pyodide = await loadPyodide({ indexURL: dir + '/', packages: ['statsmodels'], stdout() {}, stderr() {}, stdin: () => undefined }) as PythonEngine;
  } else {
    pyodide.runPython([
      'import os, warnings',
      "for _nombre in os.listdir('/mnt/data'):",
      "    os.remove(os.path.join('/mnt/data', _nombre))",
      'import pandas',
      'with warnings.catch_warnings():',
      "    warnings.simplefilter('ignore')",
      // Sólo display: 'all' también reinicia la opción de gráficos, que pide matplotlib.
      "    pandas.reset_option('^display')",
    ].join('\n'));
  }
  const runtime = new PythonRuntime(pyodide);
  await runtime.initialize();
  return runtime;
}

/** Lo que va al notebook de práctica: ni los ejemplos que fallan a propósito ni los que no se ejecutan. */
const ejecutable = (bloque: Bloque): boolean => !bloque.opciones.error && bloque.opciones.ejecutar !== false;

/** Ejecuta los bloques en orden y junta todo lo que no coincide con lo que promete la página. */
async function recorrer(runtime: PythonRuntime, lista: Bloque[]): Promise<{ fallas: string[]; obtenidas: Array<Resultado & { linea: number }> }> {
  const fallas: string[] = [];
  const obtenidas: Array<Resultado & { linea: number }> = [];
  let anterior: Resultado | null = null;

  for (const bloque of lista) {
    const donde = `línea ${bloque.linea}`;
    if (bloque.macro !== 'py') {
      if (!anterior) continue;
      const obtenido = bloque.macro === 'salida' ? anterior.texto : anterior.error;
      const esperado = normalizar(bloque.texto);
      if (obtenido !== esperado) fallas.push(`${donde}: la salida cambió\n--- en el manual\n${esperado}\n--- en ChartPython\n${obtenido}`);
      continue;
    }
    anterior = null;
    if (bloque.opciones.ejecutar === false) continue;

    const { status, outputs } = await runtime.execute(codigo(bloque));
    const resultado = resumir(status, outputs);
    anterior = resultado;
    obtenidas.push({ linea: bloque.linea, ...resultado });

    const error = bloque.opciones.error;
    if (error) {
      if (status !== 'error' || !resultado.error.startsWith(`${error}:`)) {
        fallas.push(`${donde}: tenía que dar ${error} y dio ${resultado.error || 'ok'}`);
      }
    } else if (status !== 'ok') {
      fallas.push(`${donde}: dio ${resultado.error}`);
    }
    const aviso = bloque.opciones.aviso;
    if (typeof aviso === 'string') {
      if (!resultado.avisos.includes(aviso)) fallas.push(`${donde}: tenía que avisar ${aviso} y no avisó`);
    } else if (resultado.avisos) {
      fallas.push(`${donde}: avisó algo que el manual no muestra\n${resultado.avisos}`);
    }
  }
  return { fallas, obtenidas };
}

describe('ejemplos del manual en el Pyodide de ChartPython', () => {
  // El notebook descargable saltea los ejemplos que fallan a propósito. Si uno
  // de esos creara algo que usa el siguiente (un archivo, una variable), en la
  // página andaría y con "Ejecutar todo" no: por eso corre aparte y primero.
  it('el notebook de práctica corre entero con Python recién iniciado', async () => {
    const notebook = bloques.filter((bloque, i) => ejecutable(bloque.macro === 'py' ? bloque : bloques[i - 1]));
    expect(notebook.some(bloque => bloque.opciones.error || bloque.macro === 'salida_error')).toBe(false);
    const runtime = await pythonNuevo();
    try {
      const { fallas } = await recorrer(runtime, notebook);
      expect(fallas).toEqual([]);
    } finally {
      runtime.dispose();
    }
  }, 300_000);

  it('todos corren en orden y muestran lo que dice la página', async () => {
    const runtime = await pythonNuevo();
    try {
      const { fallas, obtenidas } = await recorrer(runtime, bloques);
      if (process.env.MANUAL_SALIDAS) writeFileSync(process.env.MANUAL_SALIDAS, JSON.stringify(obtenidas, null, 1));
      expect(fallas).toEqual([]);
    } finally {
      runtime.dispose();
    }
  }, 300_000);
});
