import { beforeEach, describe, expect, it } from 'vitest';
import { initAgroVertical } from '../../src/verticals/agro/agroView';

function agroPanelSkeleton(): string {
  return `
    <section id="qb-agro-panel" style="display:none">
      <select id="qb-agro-dataset"></select>
      <div id="qb-agro-dataset-note"></div>
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
      <input id="qb-agro-m-other" value="50">
      <button id="qb-agro-m-run"></button>
      <div id="qb-agro-margin-error" style="display:none"></div>
      <div id="qb-agro-margin-result"></div>
    </section>`;
}

function selectDataset(id: string): void {
  const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
  select.value = id;
  select.dispatchEvent(new Event('change'));
}

beforeEach(() => {
  document.body.innerHTML = agroPanelSkeleton();
});

describe('initAgroVertical', () => {
  it('muestra el panel y carga los datasets cuando el vertical está habilitado', () => {
    initAgroVertical();
    const panel = document.getElementById('qb-agro-panel')!;
    expect(panel.style.display).toBe('');
    const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
    // opción vacía + 3 datasets
    expect(select.options.length).toBe(4);
  });

  it('mantiene el panel oculto cuando el vertical está deshabilitado', () => {
    initAgroVertical(false);
    expect(document.getElementById('qb-agro-panel')!.style.display).toBe('none');
    const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
    expect(select.options.length).toBe(0);
  });

  it('es un no-op si el panel no existe (Econometría no depende de Agro)', () => {
    document.body.innerHTML = '<div id="qb-results"></div>';
    expect(() => initAgroVertical()).not.toThrow();
  });

  it('no duplica opciones si se inicializa dos veces', () => {
    initAgroVertical();
    initAgroVertical();
    const select = document.getElementById('qb-agro-dataset') as HTMLSelectElement;
    expect(select.options.length).toBe(4);
  });
});

describe('selección de dataset', () => {
  it('renderiza columnas detectadas y presets sugeridos para soja', () => {
    initAgroVertical();
    selectDataset('soja_rinde_demo');

    const detection = document.getElementById('qb-agro-detection')!.innerHTML;
    expect(detection).toContain('rinde_kg_ha');
    expect(detection).toContain('lluvia');

    const presets = document.getElementById('qb-agro-presets')!.innerHTML;
    expect(presets).toContain('Modelo de rinde');
    expect(presets).toContain('motor común de ChartBay');

    const note = document.getElementById('qb-agro-dataset-note')!.innerHTML;
    expect(note).toContain('sintéticos');
  });

  it('limpia los paneles al volver a la opción vacía', () => {
    initAgroVertical();
    selectDataset('soja_rinde_demo');
    selectDataset('');
    expect(document.getElementById('qb-agro-detection')!.innerHTML).toBe('');
    expect(document.getElementById('qb-agro-presets')!.innerHTML).toBe('');
  });
});

describe('simulador de margen (UI)', () => {
  it('calcula y muestra el margen con los valores del formulario', () => {
    initAgroVertical();
    document.getElementById('qb-agro-m-run')!.dispatchEvent(new Event('click'));

    const result = document.getElementById('qb-agro-margin-result')!.innerHTML;
    // 100 ha × 3 tn/ha × 300 USD − 87.500 USD de costos = margen 2.500 USD
    expect(result).toContain('Ingreso bruto');
    expect(result).toContain('90000 USD');
    expect(result).toContain('87500 USD');
    expect(result).toContain('2500 USD');
    expect(result).toContain('Escenarios');
    expect(document.getElementById('qb-agro-margin-error')!.textContent).toBe('');
  });

  it('muestra el error de validación sin romper la vista', () => {
    initAgroVertical();
    (document.getElementById('qb-agro-m-hectares') as HTMLInputElement).value = '0';
    document.getElementById('qb-agro-m-run')!.dispatchEvent(new Event('click'));

    const error = document.getElementById('qb-agro-margin-error')!;
    expect(error.textContent).toContain('hectáreas');
    expect(document.getElementById('qb-agro-margin-result')!.innerHTML).toBe('');
  });
});
