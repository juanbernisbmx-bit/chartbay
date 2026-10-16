# Base de datos del Club de Economía

La importación directa del 15 de octubre de 2026 conserva series oficiales sin
agente ni limpieza automática. Los originales, metadatos y diferencias entre
descargas quedan disponibles para revisión posterior.

La [actualización automática en un servidor](despliegue/README.md) se ejecuta con
`scripts/actualizar_base.py`. Usa la frecuencia de las series para programar las
consultas, conserva el historial y reintenta fallos. Las unidades systemd están
preparadas; falta instalarlas en el servidor elegido.

- [Base masiva y cobertura real](datos/base/README.md): SQLite, índice CSV,
  series nacionales, provinciales y sectoriales, y pendientes medidos.
- [Importación TOP de las 24 jurisdicciones](datos/importadas/README.md):
  ampliación del catálogo local de ChartBay a 31 series con IPC.
- [Piloto auditado de ocho series](datos/AUDITORIA_8_SERIES.md): referencia anterior
  que sigue intacta y alimenta el cargador candidato de Supabase.
- [Inventario inicial de fuentes](FUENTES.md) y [100 propuestas originales](catalogo/README.md).

## Consultar la base masiva

```bash
.venv/bin/python scripts/consultar_base.py buscar 'actividad' --catalogo sspm
.venv/bin/python scripts/consultar_base.py exportar --catalogo CATALOGO --serie ID --salida outputs/serie.csv
```

La exportación genera un CSV con valores textuales originales y una ficha JSON
de procedencia. No elige entre valores distintos del mismo período. La búsqueda
incluye las series catalogadas que aún no tienen valores; el resultado informa
su cantidad de observaciones.

## Recolectar y reproducir

```bash
.venv/bin/python -u scripts/recolectar_masivo.py
.venv/bin/python -u scripts/recolectar_masivo.py --catalogos RUTA_MANIFIESTO
.venv/bin/python -u scripts/importar_masivo.py --manifiesto RUTA_MANIFIESTO
.venv/bin/python -u scripts/recolectar_masivo.py --completar RUTA_MANIFIESTO
.venv/bin/python -u scripts/importar_masivo.py --manifiesto RUTA_MANIFIESTO
```

El recolector imprime la ruta del manifiesto de cada ejecución. `--reintentar
RUTA_MANIFIESTO` reintenta errores conservando los intentos anteriores. La descarga
se limita a HTTPS oficial, 128 MiB por archivo y 250 enlaces directos en la primera
pasada. Los ZIP de valores admiten hasta 512 MiB descomprimidos. Los errores y
límites se informan; no se presentan como descargas completas.

La base SQLite y las descargas masivas se conservan localmente, fuera de Git.
El manifiesto y los scripts permiten registrar y repetir la carga; conservar una
copia de los originales es necesario para reproducir exactamente una captura.
No se escriben ni publican releases en Supabase. El catálogo masivo se consulta
desde SQLite; ChartBay mantiene su catálogo local de 31 series.
