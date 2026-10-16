# Fixtures IPC

Las pruebas son offline. `indec.html` es un HTML sintético de enlaces;
`expected.json` contiene resultados fijados a partir de la auditoría de celdas
del 7/10/2026, no calculados con el parser que se prueba.

Se reutilizan como fixtures binarios los originales conservados del repositorio
para no duplicar 6 MB de archivos XLS:

| Archivo en `datos/originales` | SHA-256 | Uso |
| --- | --- | --- |
| `sh_ipc_09_26.xls` | `f57bf8516dd7e88c733d20d39941590e160f3825a4fe8f660fc6cd3d1c79197c` | Nacional hasta agosto |
| `sh_ipc_aperturas.xls` | `57870411c5f3ede32532c634cfd8258e58e222a03d5e3925189ff79542030eac` | Seis regiones hasta agosto |
| `sh_ipc_08_26.xls` | `9cb56c3b080123f5cdd87bb3d96a2854a62e17b22f7ba01666490593f54e847d` | Nacional atrasado hasta julio |

Para ensayar errores estructurales se modifican celdas del objeto xlrd en memoria.
Para ensayar revisiones y altas se construye una base sintética temporal a partir
de la instantánea del piloto. No se reescribe ningún XLS ni el piloto real.
Las respuestas HTTP y sus fechas son simuladas; se prueba aparte el transporte.
