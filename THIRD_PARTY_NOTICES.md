# Componentes y datos de terceros

La licencia `AGPL-3.0-only` cubre el código propio de ChartBay. No reemplaza ni
modifica las licencias de los siguientes componentes, recursos y datos. Este
archivo documenta las excepciones y atribuciones que deben conservarse.

## Dependencias de software

- Base de datos usa Lucide 1.52.0 (ISC, con iconos derivados de Feather bajo
  MIT). Los avisos se conservan en `web/static/licenses/LICENSE.LUCIDE`.
- La colecta del IPC usa SheetJS CE 0.20.3 (Apache-2.0), incluido localmente
  en `supabase/functions/_vendor/xlsx-0.20.3/` con su archivo `LICENSE`.

- El bundle local del frontend incorpora Papa Parse 5.4.1, Chart.js 4.5.1,
  jsPDF 4.2.1 y jsPDF-AutoTable 5.0.8. Esos proyectos se distribuyen bajo MIT y
  conservan sus avisos en `quantbay/package-lock.json`; la AGPL de ChartBay no
  los relicencia.
- ChartBay Pro sirve localmente el núcleo oficial sin modificar de Pyodide
  0.26.4 (MPL-2.0), con un lock filtrado al cierre fijado de statsmodels:
  NumPy 1.26.4, OpenBLAS 0.3.26,
  packaging 23.2, pandas 2.2.0, Patsy 0.5.6, python-dateutil 2.9.0.post0,
  pytz 2024.1, SciPy 1.12.0, six 1.16.0 y statsmodels 0.14.2. Cada proyecto
  conserva su licencia propia (BSD, MIT y/o Apache-2.0 según corresponda); los
  avisos originales permanecen dentro de las distribuciones oficiales. Como el
  ZIP oficial de OpenBLAS contiene sólo el binario, su licencia BSD se agrega
  explícitamente como `LICENSE.OPENBLAS`. La licencia de Pyodide se conserva
  como `LICENSE.PYODIDE`, y
  `chartbay-pyodide-manifest.json` registra hashes y URLs de origen. El código
  fuente de Pyodide 0.26.4 está enlazado de forma exacta en ese manifiesto; el
  vendor se puede reproducir con `scripts/vendor_pyodide.py` sin que ChartBay
  relicencie esos componentes.
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

## Datos

- `datasets/economia/catalogo.json` incluye una copia de prueba del IPC de
  INDEC: nivel general nacional y seis regiones, con URLs originales y SHA-256
  por archivo. Las otras 93 entradas son metadatos, sin observaciones. Los
  datos no se relicencian bajo AGPL; la revisión integral y de condiciones
  de reutilización para una entrega sigue pendiente. Ver `docs/base-datos.md`.

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

## Identidad visual

El nombre ChartBay y los archivos de logotipo no se ofrecen bajo AGPL. Su
tratamiento está definido por separado en `TRADEMARKS.md`.
