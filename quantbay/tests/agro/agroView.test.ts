import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAgroContext,
  hasActiveAgroContext,
  initAgroVertical,
  presentAgroInterpretationForPro,
  presentAgroInterpretationForRegression,
  type AgroDatasetLoadParams,
  type AgroDatasetLoadResult,
  type AgroEconometriaBridge,
} from '../../src/verticals/agro/agroView';
import { runOLS } from '../../src/regression';
import type { AgroPyodideResultLike } from '../../src/verticals/agro/agroInterpretation';

function agroPanelSkeleton(): string {
  return `
    <section id="qb-agro-panel" style="display:none">
      <select id="qb-agro-dataset"></select>
      <div id="qb-agro-dataset-note"></div>
      <button id="qb-agro-use-dataset"></button>
      <p id="qb-agro-use-status"></p>
      <div id="qb-agro-detection"></div>
      <div id="qb-agro-presets"></div>
      <select id="qb-agro-m-crop"></select>
      <input id="qb-agro-m-hectares" value="100">
      <input id="qb-agro-m-yield" value="3000">
      <select id="qb-agro-m-unit"></select>
      <input id="qb-agro-m-price" value="300">
      <input id="qb-agro-m-seed" value="80">
      <input id="qb-agro-m-fert" value="120">
      <input id="qb-agro-m-agq" value="60">
      <input id="qb-agro-m-labor" value="90">
      <input id="qb-agro-m-freight" value="25">
      <input id="qb-agro-m-rent" value="400">
      <input id="qb-agro-m-rent-qq" value="0">
      <input id="qb-agro-m-soja-ref" value="0">
      <input id="qb-agro-m-harvest-pct" value="0">
      <input id="qb-agro-m-selling-pct" value="0">
      <input id="qb-agro-m-other" value="50">
      <button id="qb-agro-m-run"></button>
      <div id="qb-agro-margin-error" style="display:none"></div>
      <div id="qb-agro-margin-result"></div>
      <button id="qb-agro-m-copy" disabled></button>
      <button id="qb-agro-m-export-txt" disabled></button>
      <span id="qb-agro-m-copy-status"></span>
      <button id="qb-agro-generate-large"></button>
      <p id="qb-agro-generate-status"></p>
      <div id="qb-agro-sources"></div>
      <div id="qb-agro-templates"></div>
    </section>
    <section id="qb-results">
      <div id="qb-agro-interpretation-panel" style="display:none">
        <div id="qb-agro-interpretation-content"></div>
      </div>
    </section>
    <section id="qb-pro-results">
      <div id="qb-agro-pro-interpretation-panel" style="display:none">
        <div id="qb-agro-pro-interpretation-content"></div>
      </div>
    </section>`;
}

function selectDataset(id: string): void {
  const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
  select.value = id;
  select.dispatchEvent(new Event('change'));
}

function makeFakeBridge(result: AgroDatasetLoadResult = { ok: true, numericColumns: [] }): {
  bridge: AgroEconometriaBridge;
  calls: AgroDatasetLoadParams[];
} {
  const calls: AgroDatasetLoadParams[] = [];
  return {
    calls,
    bridge: {
      loadDataset(params) {
        calls.push(params);
        return result;
      },
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = agroPanelSkeleton();
  clearAgroContext();
});

describe('initAgroVertical', () => {
  it('muestra el panel y carga los datasets cuando el vertical está habilitado', () => {
    initAgroVertical(makeFakeBridge().bridge);
    const panel = document.getElementById('qb-agro-panel')!;
    expect(panel.style.display).toBe('');
    const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
    // opción vacía + 3 datasets sintéticos + 2 reales de MAGyP
    expect(select.options.length).toBe(6);
  });

  it('mantiene el panel oculto cuando el vertical está deshabilitado', () => {
    initAgroVertical(makeFakeBridge().bridge, false);
    expect(document.getElementById('qb-agro-panel')!.style.display).toBe('none');
    const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
    expect(select.options.length).toBe(0);
  });

  it('es un no-op si el panel no existe (Econometría no depende de Agro)', () => {
    document.body.innerHTML = '<div id="qb-results"></div>';
    expect(() => initAgroVertical(makeFakeBridge().bridge)).not.toThrow();
  });

  it('no duplica opciones ni listeners si se inicializa dos veces', () => {
    const { bridge, calls } = makeFakeBridge();
    initAgroVertical(bridge);
    initAgroVertical(bridge);
    const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
    expect(select.options.length).toBe(6);

    selectDataset('soja_rinde_demo');
    document.getElementById('qb-agro-use-dataset')!.dispatchEvent(new Event('click'));
    expect(calls).toHaveLength(1);
  });
});

describe('selección de dataset', () => {
  it('renderiza columnas detectadas y presets sugeridos para soja, con botón "Usar este preset"', () => {
    initAgroVertical(makeFakeBridge().bridge);
    selectDataset('soja_rinde_demo');

    const detection = document.getElementById('qb-agro-detection')!.innerHTML;
    expect(detection).toContain('rinde_kg_ha');
    expect(detection).toContain('lluvia');

    const presets = document.getElementById('qb-agro-presets')!.innerHTML;
    expect(presets).toContain('Modelo de rinde');
    expect(presets).toContain('motor común de ChartBay');
    expect(presets).toContain('data-agro-preset-id="agro-yield"');
    expect(presets).toContain('Usar este preset');

    const note = document.getElementById('qb-agro-dataset-note')!.innerHTML;
    expect(note).toContain('sintéticos');
  });

  it('distingue datasets reales de MAGyP de los sintéticos, en el select y en la nota', () => {
    initAgroVertical(makeFakeBridge().bridge);
    const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
    const options = Array.from(select.options);

    const sinteticoOpt = options.find(o => o.value === 'soja_rinde_demo')!;
    expect(sinteticoOpt.textContent).toContain('sintético');
    expect(sinteticoOpt.textContent).not.toContain('MAGyP');

    const realOpt = options.find(o => o.value === 'magyp_soja_rinde_provincia')!;
    expect(realOpt.textContent).toContain('datos reales');
    expect(realOpt.textContent).toContain('MAGyP');

    selectDataset('magyp_soja_rinde_provincia');
    const note = document.getElementById('qb-agro-dataset-note')!.innerHTML;
    expect(note).toContain('datos reales');
    expect(note).toContain('MAGyP');
    expect(note).not.toContain('sintéticos');
  });

  it('limpia los paneles al volver a la opción vacía', () => {
    initAgroVertical(makeFakeBridge().bridge);
    selectDataset('soja_rinde_demo');
    selectDataset('');
    expect(document.getElementById('qb-agro-detection')!.innerHTML).toBe('');
    expect(document.getElementById('qb-agro-presets')!.innerHTML).toBe('');
  });
});

describe('"Usar en Econometría" (botón por dataset)', () => {
  it('avisa si no hay dataset seleccionado y no llama al bridge', () => {
    const { bridge, calls } = makeFakeBridge();
    initAgroVertical(bridge);
    document.getElementById('qb-agro-use-dataset')!.dispatchEvent(new Event('click'));
    expect(calls).toHaveLength(0);
    expect(document.getElementById('qb-agro-use-status')!.textContent).toContain('Elegí un dataset');
  });

  it('carga el CSV del dataset con las columnas del preset por defecto preseleccionadas', () => {
    const { bridge, calls } = makeFakeBridge();
    initAgroVertical(bridge);
    selectDataset('soja_rinde_demo');
    document.getElementById('qb-agro-use-dataset')!.dispatchEvent(new Event('click'));

    expect(calls).toHaveLength(1);
    expect(calls[0].label).toContain('Soja');
    expect(calls[0].csvText).toContain('rinde_kg_ha');
    expect(calls[0].suggestedY).toBe('rinde_kg_ha');
    expect(calls[0].suggestedX).toEqual(expect.arrayContaining(['lluvia_mm', 'temperatura_media']));
    expect(hasActiveAgroContext()).toBe(true);

    const status = document.getElementById('qb-agro-use-status')!.textContent ?? '';
    expect(status).toContain('Soja');
    expect(status).toContain('Modelo de rinde');
  });

  it('muestra el mensaje del bridge y no fija contexto agro si la carga falla', () => {
    const { bridge } = makeFakeBridge({ ok: false, numericColumns: [], message: 'CSV inválido' });
    initAgroVertical(bridge);
    selectDataset('soja_rinde_demo');
    document.getElementById('qb-agro-use-dataset')!.dispatchEvent(new Event('click'));

    expect(document.getElementById('qb-agro-use-status')!.textContent).toBe('CSV inválido');
    expect(hasActiveAgroContext()).toBe(false);
  });
});

describe('"Usar este preset" (por preset sugerido)', () => {
  it('aplica el preset elegido y actualiza el status con Y/X y la razón', () => {
    const { bridge, calls } = makeFakeBridge();
    initAgroVertical(bridge);
    selectDataset('maiz_margen_demo');

    const presetButton = document.querySelector<HTMLElement>('[data-agro-preset-id="agro-margin"]')!;
    presetButton.dispatchEvent(new Event('click', { bubbles: true }));

    expect(calls).toHaveLength(1);
    expect(calls[0].suggestedY).toBe('margen_bruto_usd_ha');
    expect(hasActiveAgroContext()).toBe(true);
    expect(document.getElementById('qb-agro-use-status')!.textContent).toContain('Modelo de margen');
  });

  it('ignora el click si no hay un dataset seleccionado en el desplegable', () => {
    const { bridge, calls } = makeFakeBridge();
    initAgroVertical(bridge);
    // Simula un botón de preset "huérfano" sin dataset activo en el select.
    document.getElementById('qb-agro-presets')!.innerHTML =
      '<button data-agro-preset-id="agro-yield">Usar este preset</button>';
    document.querySelector('[data-agro-preset-id]')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(calls).toHaveLength(0);
  });
});

describe('presentAgroInterpretationForRegression', () => {
  const olsResult = runOLS({
    X: [[1], [2], [3], [4], [5], [6]],
    y: [3.1, 4.9, 7.2, 9.1, 10.8, 13.2],
    featureNames: ['lluvia_mm'],
    yName: 'rinde_kg_ha',
  });

  it('no muestra nada si no hay contexto agro activo', () => {
    presentAgroInterpretationForRegression('rinde_kg_ha', olsResult, 'lin-lin');
    expect(document.getElementById('qb-agro-interpretation-panel')!.style.display).toBe('none');
  });

  it('no muestra nada si la Y corrida no coincide con la del preset agro activo', () => {
    const { bridge } = makeFakeBridge();
    initAgroVertical(bridge);
    selectDataset('soja_rinde_demo');
    document.getElementById('qb-agro-use-dataset')!.dispatchEvent(new Event('click'));

    presentAgroInterpretationForRegression('otra_variable', olsResult, 'lin-lin');
    expect(document.getElementById('qb-agro-interpretation-panel')!.style.display).toBe('none');
  });

  it('muestra la lectura agropecuaria cuando la Y coincide con el contexto activo', () => {
    const { bridge } = makeFakeBridge();
    initAgroVertical(bridge);
    selectDataset('soja_rinde_demo');
    document.getElementById('qb-agro-use-dataset')!.dispatchEvent(new Event('click'));

    presentAgroInterpretationForRegression('rinde_kg_ha', olsResult, 'lin-lin');
    const panel = document.getElementById('qb-agro-interpretation-panel')!;
    expect(panel.style.display).toBe('');
    expect(document.getElementById('qb-agro-interpretation-content')!.innerHTML).toContain('Lluvia y rinde');
  });
});

describe('presentAgroInterpretationForPro', () => {
  function makeProResult(overrides: Partial<AgroPyodideResultLike> = {}): AgroPyodideResultLike {
    return {
      ok: true,
      functionalForm: 'lin-lin',
      nobs: 40,
      coefficients: [
        { name: 'Intercept', estimate: 100, stdError: 5, pValue: 0.0001 },
        { name: 'lluvia_mm', estimate: 2.1, stdError: 0.3, pValue: 0.0001 },
      ],
      rSquared: 0.6,
      rSquaredAdj: 0.58,
      warnings: [],
      ...overrides,
    };
  }

  it('no muestra nada si el resultado Pro no fue exitoso', () => {
    const { bridge } = makeFakeBridge();
    initAgroVertical(bridge);
    selectDataset('soja_rinde_demo');
    document.getElementById('qb-agro-use-dataset')!.dispatchEvent(new Event('click'));

    presentAgroInterpretationForPro('rinde_kg_ha', { ok: false, warnings: [] });
    expect(document.getElementById('qb-agro-pro-interpretation-panel')!.style.display).toBe('none');
  });

  it('muestra la lectura agropecuaria para un resultado Pro exitoso con Y coincidente', () => {
    const { bridge } = makeFakeBridge();
    initAgroVertical(bridge);
    selectDataset('soja_rinde_demo');
    document.getElementById('qb-agro-use-dataset')!.dispatchEvent(new Event('click'));

    presentAgroInterpretationForPro('rinde_kg_ha', makeProResult());
    const panel = document.getElementById('qb-agro-pro-interpretation-panel')!;
    expect(panel.style.display).toBe('');
    const content = document.getElementById('qb-agro-pro-interpretation-content')!.innerHTML;
    expect(content).toContain('Lluvia y rinde');
    expect(content).not.toContain('Intercept');
  });
});

describe('simulador de margen (UI)', () => {
  it('no hace nada al copiar/exportar si todavía no se calculó ningún margen', () => {
    initAgroVertical(makeFakeBridge().bridge);
    document.getElementById('qb-agro-m-copy')!.dispatchEvent(new Event('click'));
    document.getElementById('qb-agro-m-export-txt')!.dispatchEvent(new Event('click'));
    expect(document.getElementById('qb-agro-m-copy-status')!.textContent).toBe('');
  });

  it('calcula y muestra el margen con los valores del formulario', () => {
    initAgroVertical(makeFakeBridge().bridge);
    document.getElementById('qb-agro-m-run')!.dispatchEvent(new Event('click'));

    const result = document.getElementById('qb-agro-margin-result')!.innerHTML;
    // 100 ha × 3 tn/ha × 300 USD − 87.500 USD de costos = margen 2.500 USD
    expect(result).toContain('Ingreso bruto');
    expect(result).toContain('90000 USD');
    expect(result).toContain('87500 USD');
    expect(result).toContain('2500 USD');
    expect(result).toContain('Escenarios');
    expect(result).toContain('Sensibilidad precio × rinde');
    expect(document.getElementById('qb-agro-margin-error')!.textContent).toBe('');
  });

  it('incluye cosecha, comercialización y alquiler en qq en el cálculo del margen', () => {
    initAgroVertical(makeFakeBridge().bridge);
    (document.getElementById('qb-agro-m-harvest-pct') as HTMLInputElement).value = '9';
    (document.getElementById('qb-agro-m-selling-pct') as HTMLInputElement).value = '8';
    (document.getElementById('qb-agro-m-rent') as HTMLInputElement).value = '0';
    (document.getElementById('qb-agro-m-rent-qq') as HTMLInputElement).value = '18';
    (document.getElementById('qb-agro-m-soja-ref') as HTMLInputElement).value = '320';
    document.getElementById('qb-agro-m-run')!.dispatchEvent(new Event('click'));

    const result = document.getElementById('qb-agro-margin-result')!.innerHTML;
    // Ingreso 90.000; costos: 400/ha fijos × 100 + alquiler 18 qq × 0,1 × 320 = 576/ha × 100
    // + flete 7.500 + 17% de 90.000 = 15.300 → 40.000 + 57.600 + 7.500 + 15.300 = 120.400.
    expect(result).toContain('90000 USD');
    expect(result).toContain('120400 USD');
    expect(document.getElementById('qb-agro-margin-error')!.textContent).toBe('');
  });

  it('muestra el error de validación sin romper la vista', () => {
    initAgroVertical(makeFakeBridge().bridge);
    (document.getElementById('qb-agro-m-hectares') as HTMLInputElement).value = '0';
    document.getElementById('qb-agro-m-run')!.dispatchEvent(new Event('click'));

    const error = document.getElementById('qb-agro-margin-error')!;
    expect(error.textContent).toContain('hectáreas');
    expect(document.getElementById('qb-agro-margin-result')!.innerHTML).toBe('');
  });

  it('habilita copiar/exportar tras un cálculo exitoso y los deshabilita si falla', () => {
    initAgroVertical(makeFakeBridge().bridge);
    document.getElementById('qb-agro-m-run')!.dispatchEvent(new Event('click'));
    expect((document.getElementById('qb-agro-m-copy') as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById('qb-agro-m-export-txt') as HTMLButtonElement).disabled).toBe(false);

    (document.getElementById('qb-agro-m-hectares') as HTMLInputElement).value = '-1';
    document.getElementById('qb-agro-m-run')!.dispatchEvent(new Event('click'));
    expect((document.getElementById('qb-agro-m-copy') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('qb-agro-m-export-txt') as HTMLButtonElement).disabled).toBe(true);
  });

  it('copiar resumen escribe al portapapeles y muestra confirmación', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    initAgroVertical(makeFakeBridge().bridge);
    document.getElementById('qb-agro-m-run')!.dispatchEvent(new Event('click'));
    document.getElementById('qb-agro-m-copy')!.dispatchEvent(new Event('click'));

    await vi.waitFor(() => {
      expect(document.getElementById('qb-agro-m-copy-status')!.textContent).toBe('Copiado ✓');
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain('Margen bruto: 2500.00 USD');
    expect(copiedText).toContain('Escenarios');
  });
});

describe('aviso de capacidad n/k en el status', () => {
  it('incluye el aviso de capacidad al usar un dataset chico con variables categóricas', () => {
    const { bridge } = makeFakeBridge();
    initAgroVertical(bridge);
    selectDataset('soja_rinde_demo');
    document.getElementById('qb-agro-use-dataset')!.dispatchEvent(new Event('click'));

    const status = document.getElementById('qb-agro-use-status')!.textContent ?? '';
    expect(status).toContain('categórica');
  });
});

describe('"Generar demo grande"', () => {
  it('genera el dataset, lo agrega al select, lo selecciona y refresca detección/presets', () => {
    initAgroVertical(makeFakeBridge().bridge);
    document.getElementById('qb-agro-generate-large')!.dispatchEvent(new Event('click'));

    const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
    // opción vacía + 5 datasets fijos (3 sintéticos + 2 reales) + 1 generado
    expect(select.options.length).toBe(7);
    expect(select.value).toContain('_large_synthetic_demo');

    const status = document.getElementById('qb-agro-generate-status')!.textContent ?? '';
    expect(status).toContain('1000 filas');

    const detection = document.getElementById('qb-agro-detection')!.innerHTML;
    expect(detection).toContain('rinde_kg_ha');

    const presets = document.getElementById('qb-agro-presets')!.innerHTML;
    expect(presets).toContain('Modelo de rinde');
  });

  it('no duplica la opción del select si se genera más de una vez', () => {
    initAgroVertical(makeFakeBridge().bridge);
    document.getElementById('qb-agro-generate-large')!.dispatchEvent(new Event('click'));
    document.getElementById('qb-agro-generate-large')!.dispatchEvent(new Event('click'));
    const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
    expect(select.options.length).toBe(7);
  });

  it('el dataset generado se puede cargar en Econometría con el preset por defecto', () => {
    const { bridge, calls } = makeFakeBridge();
    initAgroVertical(bridge);
    document.getElementById('qb-agro-generate-large')!.dispatchEvent(new Event('click'));
    document.getElementById('qb-agro-use-dataset')!.dispatchEvent(new Event('click'));

    expect(calls).toHaveLength(1);
    expect(calls[0].suggestedY).toBe('rinde_kg_ha');
    expect(calls[0].csvText.split('\n')).toHaveLength(1001); // header + 1000 filas
  });
});

describe('fuentes de datos y templates CSV', () => {
  it('renderiza el catálogo de fuentes al iniciar', () => {
    initAgroVertical(makeFakeBridge().bridge);
    const sources = document.getElementById('qb-agro-sources')!.innerHTML;
    expect(sources).toContain('Estimaciones Agrícolas Argentina');
    expect(sources).toContain('FAOSTAT');
  });

  it('renderiza los templates CSV con botón de descarga', () => {
    initAgroVertical(makeFakeBridge().bridge);
    const templates = document.getElementById('qb-agro-templates')!.innerHTML;
    expect(templates).toContain('data-agro-template-id="rinde"');
    expect(templates).toContain('Descargar template CSV');
  });

  it('descarga el template elegido al hacer click', () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    try {
      initAgroVertical(makeFakeBridge().bridge);
      const button = document.querySelector<HTMLElement>('[data-agro-template-id="margen"]')!;
      expect(() => button.dispatchEvent(new Event('click', { bubbles: true }))).not.toThrow();
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it('ignora el click si no viene de un botón de template', () => {
    initAgroVertical(makeFakeBridge().bridge);
    expect(() =>
      document.getElementById('qb-agro-templates')!.dispatchEvent(new Event('click', { bubbles: true }))
    ).not.toThrow();
  });
});
