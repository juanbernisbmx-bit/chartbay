export type ChartBayVersion = 'lite' | 'pro' | 'mega_pro';

export type ChartBayEngine = 'typescript' | 'pyodide' | 'server_python';

export type ChartBayVersionConfig = {
  id: ChartBayVersion;
  label: string;
  status: 'available' | 'experimental' | 'locked';
  description: string;
  maxCsvSizeMb: number;
  engine: ChartBayEngine;
  features: {
    ols: boolean;
    rls: boolean;
    functionalForms: boolean;
    autoFunctionalFormRecommendation: boolean;
    categoricalDummies: boolean;
    breuschPagan: boolean;
    robustErrors: boolean;
    pyodideStatsmodels: boolean;
    advancedTimeSeries: boolean;
    quantFinance: boolean;
    largeFiles: boolean;
  };
};

const LITE_FEATURES: ChartBayVersionConfig['features'] = {
  ols: true,
  rls: true,
  functionalForms: true,
  autoFunctionalFormRecommendation: true,
  categoricalDummies: true,
  breuschPagan: true,
  robustErrors: false,
  pyodideStatsmodels: false,
  advancedTimeSeries: false,
  quantFinance: false,
  largeFiles: false,
};

export const CHARTBAY_VERSIONS: Record<ChartBayVersion, ChartBayVersionConfig> = {
  lite: {
    id: 'lite',
    label: 'Lite',
    status: 'available',
    description: 'Versión educativa. Corre entera en el navegador: el CSV se limpia y se tipa con un motor en C++ compilado a WebAssembly, y el cálculo lo hace el motor TypeScript.',
    // Medido: 516 MB y 7,9 M de filas se procesan en 17 s con 727 MB de heap
    // WASM. El tope de 100 MB deja margen sobre eso y, por encima, el preflight
    // avisa según el equipo de cada uno. Era 2 MB, calculado para cuando esto
    // pasaba por PapaParse y armaba un objeto por fila.
    maxCsvSizeMb: 100,
    engine: 'typescript',
    features: { ...LITE_FEATURES },
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    status: 'available',
    description:
      'ChartBay Pro v1 ejecuta OLS con statsmodels vía Pyodide (Python en el navegador), con las ' +
      '4 formas funcionales (lin-lin, log-lin, lin-log, log-log), variables categóricas vía dummies (misma ' +
      'lógica que Lite), intercepto automático, errores estándar clásicos o robustos (HC1/HC3), diagnóstico ' +
      'Breusch-Pagan y test de restricciones lineales Rβ = q (Wald/F vía statsmodels, sin re-estimar los ' +
      'coeficientes bajo la restricción). En series de tiempo Pro incluye ADF, ACF, PACF, Ljung-Box, ARIMA ' +
      'manual, forecast con intervalos, gráfico e índice temporal opcional con fechas reales cuando el CSV lo permite.',
    // Sin cambios a propósito. Pro no usa el limpiador: le pasa el CSV entero
    // como texto a Python, que además carga numpy, pandas y statsmodels en el
    // navegador. Ese perfil de memoria no se midió nunca, así que subir el tope
    // sería inventar un número. Medir Pyodide es su propia tarea.
    maxCsvSizeMb: 10,
    engine: 'pyodide',
    features: {
      ...LITE_FEATURES,
      robustErrors: true,
      pyodideStatsmodels: true,
      largeFiles: true,
    },
  },
  mega_pro: {
    id: 'mega_pro',
    label: 'Mega Pro',
    status: 'locked',
    description: 'Mega Pro estará orientado a archivos grandes, series de tiempo avanzadas y finanzas cuantitativas.',
    maxCsvSizeMb: 50,
    engine: 'server_python',
    features: {
      ...LITE_FEATURES,
      robustErrors: true,
      pyodideStatsmodels: true,
      advancedTimeSeries: true,
      quantFinance: true,
      largeFiles: true,
    },
  },
};

export function getVersionConfig(version: ChartBayVersion): ChartBayVersionConfig {
  return CHARTBAY_VERSIONS[version];
}

export function validateCsvFileSize(
  fileSizeBytes: number,
  versionConfig: ChartBayVersionConfig
): { ok: true } | { ok: false; message: string } {
  const maxBytes = versionConfig.maxCsvSizeMb * 1024 * 1024;
  if (fileSizeBytes <= maxBytes) return { ok: true };
  const sizeMb = (fileSizeBytes / 1024 / 1024).toFixed(1);
  return {
    ok: false,
    message:
      `El archivo pesa ${sizeMb} MB. El máximo de ChartBay ${versionConfig.label} es ${versionConfig.maxCsvSizeMb} MB. ` +
      (versionConfig.id === 'lite'
        ? 'Elegí Pro o reducí el tamaño del CSV.'
        : 'Reducí el tamaño del CSV.'),
  };
}
