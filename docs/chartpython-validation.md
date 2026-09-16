# Validación de ChartPython

Fecha: 16 de septiembre de 2026. Implementación validada: `d85c299`, rama
`codex/chartpython`, basada en `42e3a1d`.

## Comprobaciones automáticas

Entorno: macOS ARM64, Node 22.23.2, Python del entorno virtual del proyecto
con statsmodels 0.14.6. El kernel usa el Pyodide 0.26.4 vendorizado.

| Comprobación | Resultado |
| --- | --- |
| Vitest completo, con `CHARTBAY_PYTHON` configurado | 1419 pruebas, 87 archivos, todas pasan |
| Kernel y cliente incluidos en Vitest | 21 pruebas; ejecución real de CPython/WASM |
| `tsc --noEmit` | Sin errores |
| Flask (`tests/test_web.py`) | 52/52 pasan |
| `npm run build` con Node 22 | Correcto; todos los bundles coinciden con Git |
| `git diff --check 42e3a1d..HEAD` | Sin errores |

Las pruebas web incluyen ruta, navegación, apagado mediante flag, CSP del
worker y presencia de fuentes y bundles en la descarga del código fuente.

## Comprobaciones en navegador

### Chromium integrado (15 de septiembre)

- Importar un `.ipynb` muestra sus salidas guardadas sin ejecutar Python.
- Un output HTML con script y enlace `javascript:` se muestra saneado.
- Un CSV subido se lee con pandas usando un nombre relativo a `/mnt/data`.
- OLS de statsmodels devuelve los parámetros esperados `[1.0, 2.0]`.
- Una segunda celda puede consultar variables de la primera: `datos.shape`
  devuelve `(4, 2)`.
- Al recargar se recuperan código, salidas y CSV de IndexedDB; el kernel
  permanece apagado hasta ejecutar y vuelve a recibir el archivo subido.
- Crear otro notebook reinicia el kernel y vacía el panel de archivos.
- Sin errores de consola en el flujo observado.

### Safari de escritorio (16 de septiembre)

- Carga real de Pyodide y ejecución de pandas; DataFrame renderizado como tabla.
- CSV generado por Python descargado y leído desde disco. Contenido exacto:
  `x,y\n1,3\n2,5\n`.
- Notebook descargado y validado como JSON nbformat 4, con código, contador de
  ejecución y output HTML conservados.
- Un bucle infinito se interrumpe desde el botón sin bloquear la página.
- Después de interrumpir, una nueva ejecución de `6 * 7` devuelve `42` y el
  contador vuelve a 1.

## Alcance y límites

El MVP queda validado para revisión local. No se hizo merge, push ni despliegue.
La interfaz continúa marcada Beta. Estas pruebas no reemplazan una matriz
completa de Safari, dispositivos móviles reales y equipos de pocos recursos.

La primera ejecución descarga aproximadamente 115 MB de paquetes locales.
Interrumpir termina el worker y elimina variables y archivos generados en su
memoria; las celdas y los archivos subidos persistidos se conservan.

El navegador integrado no emitió el evento de descarga durante el intento de
QA; la descarga efectiva de CSV y `.ipynb` se verificó en Safari. Chrome nativo
mostró una página en blanco durante esta sesión y no se usó para certificar las
descargas; no se determinó la causa. Chromium integrado y Safari sí renderizaron
la página local.
