# Componentes y datos de terceros

La licencia `AGPL-3.0-only` cubre el código propio de ChartBay. No reemplaza ni
modifica las licencias de los siguientes componentes, recursos y datos. Este
archivo documenta las excepciones y atribuciones que deben conservarse.

## Dependencias de software

- El bundle local del frontend incorpora Papa Parse 5.4.1, Chart.js 4.5.1,
  jsPDF 4.2.1 y jsPDF-AutoTable 5.0.8. Esos proyectos se distribuyen bajo MIT y
  conservan sus avisos en `quantbay/package-lock.json`; la AGPL de ChartBay no
  los relicencia.
- ChartBay Pro carga Pyodide 0.26.4 (MPL-2.0) y, dentro de ese entorno, NumPy,
  pandas, SciPy y statsmodels, que conservan sus licencias BSD respectivas.
- Las dependencias npm instaladas para compilar y probar se mantienen bajo las
  licencias registradas individualmente en `quantbay/package-lock.json`. El
  conjunto actual contiene MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause,
  Apache-2.0, MPL-2.0/Apache-2.0 a elección, MIT/Zlib y el aviso MIT específico
  de `rgbcolor`; ninguna se declara como obra propia de ChartBay.
- Las dependencias Python declaradas en `requirements.txt` y
  `backend/pyproject.toml` conservan las licencias publicadas por cada proyecto.
  Incluyen componentes bajo BSD, MIT y Apache-2.0. El backend es independiente
  y no se despliega con la aplicación Flask 1.0.
- Las páginas usan IBM Plex Sans e IBM Plex Mono desde Google Fonts. Las fuentes
  IBM Plex se ofrecen bajo SIL Open Font License 1.1 y no se incorporan al
  repositorio.
- El código heredado e inactivo de Mercados referencia Marked, DOMPurify y el
  widget de TradingView. No forma parte de las páginas activas de ChartBay 1.0;
  si se reactiva, deben revisarse nuevamente sus versiones y términos.

## Datos

- `quantbay/src/verticals/agro/data/magyp.ts` contiene un recorte transformado
  de “Agricultura - Estimaciones agrícolas” del MAGyP, bajo CC BY 4.0. El propio
  archivo conserva fuente, URL, fecha de descarga y transformaciones. Agro está
  inactivo en 1.0, pero la atribución se mantiene porque los datos viajan en el
  código fuente.
- Las series de World Bank se consultan en tiempo de ejecución desde World
  Development Indicators. No se incluyen en el repositorio ni quedan cubiertas
  por la AGPL: cada conjunto conserva la atribución y la licencia publicada por
  World Bank, que debe verificarse antes de redistribuirlo.
- FRED se consulta en tiempo de ejecución. ChartBay no incorpora, relicencia ni
  concede derechos sobre sus series. Los términos varían por serie; al mostrar,
  publicar o redistribuir datos deben revisarse las notas de copyright, citarse
  la fuente original y conservarse la atribución a FRED que corresponda.
- Los CSV conservan `date,value` como columnas normalizadas y agregan
  `source,series_id,terms_url`; los JSON incluyen los mismos metadatos. Así la
  atribución y el enlace oficial de términos acompañan al archivo descargado.
  En FRED los derechos pueden variar por serie: el enlace no reemplaza la
  revisión de sus notas ni una autorización que el titular pueda exigir.
- Los cinco CSV de `datasets/` son casos educativos propios del repositorio, no
  copias de una base externa.
- El código inactivo de Mercados puede consultar Yahoo Finance. ChartBay 1.0 no
  incorpora ni redistribuye un dataset de Yahoo Finance.

## Identidad visual

El nombre ChartBay y los archivos de logotipo no se ofrecen bajo AGPL. Su
tratamiento está definido por separado en `TRADEMARKS.md`.
