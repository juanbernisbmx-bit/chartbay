# Actualización automática en un servidor

El script [`actualizar_base.py`](../scripts/actualizar_base.py) consulta las fuentes
que tienen una revisión pendiente y agrega sus novedades a la base SQLite. El
servidor lo inicia cada hora mediante systemd; no necesita un agente ni una sesión
de Codex. Estos archivos están preparados para Linux con systemd, pero todavía no
están instalados en un servidor remoto.

## Frecuencias

La configuración está en [`config/actualizacion.json`](../config/actualizacion.json).
La frecuencia estadística y la frecuencia de consulta son campos diferentes:

| Datos de la serie | Consultar la fuente cada |
| --- | ---: |
| Diarios | 6 horas |
| Semanales | 24 horas |
| Mensuales | 24 horas |
| Trimestrales | 7 días |
| Semestrales | 14 días |
| Anuales | 30 días |

Son intervalos de consulta configurables, no fechas oficiales de publicación. Una
serie mensual puede publicarse cualquier día del mes y rectificar datos anteriores.
Consultar diariamente permite detectar su publicación sin adivinar esa fecha.
Si se conoce el calendario de una fuente, se puede ajustar su trabajo específico.

Las series de un mismo archivo se consultan juntas usando el intervalo más corto
del grupo. La descarga del dump completo de un catálogo también actualiza series
de frecuencia más lenta. Para la base actual hay 445 trabajos agrupados: 18
catálogos, 423 CSV, el conjunto sectorial, IPC, TOP y el descubrimiento de metadatos.
El nodo de prueba del portal está excluido. El plan se recalcula desde SQLite en
cada ejecución, de modo que los catálogos descubiertos entren en la siguiente.

Ejemplo de ajuste dentro de la clave `trabajos` del JSON:

```json
{
  "club:ipc": {"cada_horas": 24, "activo": true},
  "catalogo:bcra": {"cada_horas": 6, "activo": true}
}
```

El proceso atiende hasta 32 trabajos pendientes por ejecución, empezando por los
más atrasados. El límite se puede ajustar según el servidor y el tamaño del catálogo.

## Comportamiento

- Guarda la próxima consulta, el último éxito y cada fallo en
  `datos/actualizaciones/control.sqlite`. El estado sobrevive a reinicios.
- Usa `ETag`/`Last-Modified` cuando están disponibles. Ante HTTP 304 reutiliza el
  original solo si sigue presente y su SHA-256 coincide. Si el servidor no ofrece
  validadores, descarga y compara el hash.
- Los originales se guardan por hash. Un archivo ya importado no vuelve a cargarse.
  Un archivo nuevo agrega observaciones nuevas y cifras diferentes de períodos
  anteriores; no vuelve a copiar todas las cifras idénticas del histórico.
- Cada fuente se incorpora en una transacción. Un archivo inválido o una descarga
  fallida conservan los datos anteriores y generan un reintento a 1, 2, 4, 8 horas,
  hasta un máximo de 24 horas. Las otras fuentes continúan.
- Un bloqueo compartido impide dos actualizadores simultáneos y evita que la
  importación completa se ejecute mientras el actualizador escribe.
- IPC y TOP descubren sus archivos desde la página oficial; no dependen de que el
  nombre del Excel siga igual. Conservan los controles de los extractores existentes.
- Refresca el índice CSV y escribe `datos/base/estado_actualizacion.json`. El informe
  de la importación inicial se mantiene como foto histórica.

La base conserva las revisiones sin elegir automáticamente una cifra cuando hay
varias para un período. No rellena faltantes ni corrige valores. No publica en
Supabase ni cambia el catálogo JSON del frontend de ChartBay. Los archivos de los
que aún no existe extractor siguen pendientes; descargarlos no los convierte en
series actualizadas.

## Preparar el servidor

Se requiere Python 3.10 o posterior, certificados HTTPS vigentes, conexión a
internet y espacio para la base, los originales y los archivos temporales. `curl`
es la alternativa cuando Python no puede verificar la cadena de certificados;
nunca se desactiva la verificación TLS.

Copiar el proyecto a `/opt/club-economia`, incluidos `datos/base/`, los originales,
el piloto y el catálogo importado. Conservar rutas relativas. Omitir `.venv`, `.git`
y `.env` al transferirlo. La actualización de estas fuentes públicas no necesita
claves de API ni contraseñas de Supabase.

Crear el usuario `club-economia` si no existe y asignarle esa carpeta. Por ejemplo,
en Debian/Ubuntu:

```bash
sudo useradd --system --home-dir /opt/club-economia --shell /usr/sbin/nologin club-economia
cd /opt/club-economia
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
sudo chown -R club-economia:club-economia /opt/club-economia
sudo -u club-economia .venv/bin/python scripts/actualizar_base.py plan
```

Si el usuario ya existe, omitir `useradd`. La ruta y el usuario deben coincidir con
los de `club-economia.service`; editar la unidad si se elige otra ubicación.

Primera ejecución limitada y comprobación:

```bash
sudo -u club-economia .venv/bin/python scripts/actualizar_base.py ejecutar --limite 1
sudo -u club-economia .venv/bin/python scripts/actualizar_base.py estado
```

## Activar y verificar

Desde `/opt/club-economia`, en el servidor:

```bash
sudo install -m 644 despliegue/club-economia.service /etc/systemd/system/
sudo install -m 644 despliegue/club-economia.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now club-economia.timer
systemctl list-timers club-economia.timer
journalctl -u club-economia.service -n 100
```

El temporizador dispara una comprobación cada hora, con hasta cinco minutos de
dispersión. `Persistent=true` recupera una comprobación pendiente después de un
apagado; el script consulta el histórico disponible y no repite una ejecución por
cada hora perdida.

Referencia: [temporizadores de systemd, documentación del proyecto](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml).

Comandos útiles para operación:

```bash
.venv/bin/python scripts/actualizar_base.py plan --trabajo club:ipc
.venv/bin/python scripts/actualizar_base.py ejecutar --trabajo club:ipc --forzar
.venv/bin/python scripts/actualizar_base.py estado
sudo systemctl disable --now club-economia.timer
```

`--forzar` consulta una fuente antes de su próxima fecha; no salta la validación ni
la protección contra duplicados. Los fallos aparecen en el estado, en las corridas
y en el journal; no se envían mensajes a servicios externos.
