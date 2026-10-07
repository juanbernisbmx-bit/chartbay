# Despliegue del servicio de datos (HTTPS y cron)

Este documento instala, en el equipo Ubuntu del club, lo que corre fuera de Supabase: la interfaz de revisión, detrás
de HTTPS, las tareas programadas y el latido hacia un monitor externo. La base de datos (Supabase, sus roles y sus migraciones) está en
[`despliegue-supabase.md`](despliegue-supabase.md); hacé eso primero.

```
INDEC ──► cron: ejecutar ──► PostgreSQL (Supabase) ◄── ChartBay (solo lectura)
                                  ▲                        
   revisores ──HTTPS──► Caddy ──► gunicorn (revisión) ─────┘
   cron: avisar ──► Slack / correo                         ▲
   cron: agente ──► modelo local (esta misma computadora) ─┘  (solo escribe propuestas)
   cron: respaldar ──► otro disco: volcado de la base y copia del crudo
   cron: latido ──► monitor externo (Healthchecks): si deja de latir, avisa él
```

Los archivos están en `servicio_datos/despliegue/`:

| Archivo | Va a | Qué es |
| --- | --- | --- |
| `entorno.ejemplo` | `/etc/chartbay-datos/entorno` | Los secretos y la configuración. Lo leen las tareas y la interfaz |
| `chartbay-revision.service` | `/etc/systemd/system/` | La interfaz de revisión como servicio, escuchando solo en `127.0.0.1:8000` |
| `Caddyfile` | `/etc/caddy/Caddyfile` | El HTTPS: certificado automático y proxy hacia el servicio |
| `chartbay-datos.cron` | `/etc/cron.d/chartbay-datos` | Las tareas programadas y el latido |
| `logrotate-chartbay-datos` | `/etc/logrotate.d/chartbay-datos` | Rotación de los registros de cron |

## Qué se verificó y qué no

Se probó en una Mac, con herramientas reales: el Caddyfile pasa `caddy validate` y `caddy fmt`; gunicorn detrás de Caddy con un
certificado local sirvió la interfaz por HTTPS (HTTP/2, redirección de HTTP, HSTS solo por HTTPS, 401 sin credenciales, origen
ajeno y token faltante rechazados con 403, y un cliente que falsea `X-Forwarded-For` no esquiva el límite de intentos). El
lanzador de tareas tiene pruebas de bloqueo, límite de tiempo y permisos.

El analista (sección 7) se probó solo contra un servidor falso que habla el mismo protocolo que Ollama y los demás: **nunca con un
modelo real**. Que su código ande no dice nada sobre si un modelo concreto sirve; para eso está `agente probar`.

Los respaldos (sección 8) se probaron contra un PostgreSQL 17 local con `pg_dump` y `pg_restore` 17 reales: volcado con un rol de solo
lectura armado con `sql-del-rol`, ensayo de restauración completo y recuperación del crudo. **No se probó** contra Supabase (ni volcar
por el pooler ni restaurar ahí), ni el montaje del disco, ni el PostgreSQL de ensayo en Ubuntu.

El latido (sección 9) se probó contra servidores locales: un monitor falso con el protocolo de Healthchecks, el `/salud` de la
interfaz de verdad y un HTTPS con certificados generados para la prueba (uno vigente, uno por vencer y uno que no es de confianza).
**No se probó** contra Healthchecks.io de verdad.

**No se probó**: la unidad de systemd ni el archivo de cron en Ubuntu (no hay cómo hacerlo desde una Mac; usan directivas
comunes, y las pruebas fijan que sean coherentes entre sí), ni un certificado real de Let's Encrypt, ni la conexión a Supabase.
Seguí la lista de comprobación del final al instalar.

## 1. Usuario y carpetas

```bash
sudo adduser --system --group --home /var/lib/chartbay-datos chartbay-datos
sudo mkdir -p /opt/chartbay-datos /var/lib/chartbay-datos/crudo /var/log/chartbay-datos /etc/chartbay-datos
sudo chown -R chartbay-datos:chartbay-datos /opt/chartbay-datos /var/lib/chartbay-datos /var/log/chartbay-datos /etc/chartbay-datos
sudo chmod 750 /var/lib/chartbay-datos /etc/chartbay-datos
```

`/var/lib/chartbay-datos/crudo` guarda los `.xls` originales: la base sola no alcanza para reconstruir una descarga si se
pierde. **Respaldala** (junto con la base; ver la sección 8).

## 2. El código y sus dependencias

```bash
sudo -u chartbay-datos git clone <URL-DEL-REPO> /opt/chartbay-datos/repo
cd /opt/chartbay-datos/repo && sudo -u chartbay-datos git checkout <RAMA-A-DESPLEGAR>
sudo -u chartbay-datos python3 -m venv /opt/chartbay-datos/venv
sudo -u chartbay-datos /opt/chartbay-datos/venv/bin/pip install -r servicio_datos/requirements.txt
```

La rama tiene que incluir el parser y la validación del IPC (están integrados en `claude/base-datos-postgres`): sin ellos
`ejecutar` no corre.

## 3. Secretos

```bash
sudo -u chartbay-datos cp servicio_datos/despliegue/entorno.ejemplo /etc/chartbay-datos/entorno
sudo chmod 600 /etc/chartbay-datos/entorno && sudo -u chartbay-datos nano /etc/chartbay-datos/entorno
```

- `DATOS_DATABASE_URL`: la del rol `datos_escritura` (de `despliegue-supabase.md`). **No** pongas acá la URL del administrador.
- `DATOS_REVISORES`: un `usuario=hash` por revisor, separados por `;`. Cada hash:
  `sudo -u chartbay-datos /opt/chartbay-datos/venv/bin/python -m servicio_datos.revision clave NOMBRE` (pide la contraseña, de al
  menos 12 caracteres) e imprime la línea lista.
- `DATOS_REVISION_URL`: la dirección pública `https://...` (sale en los enlaces de los avisos).
- Los canales de avisos (`DATOS_AVISOS_*`) son opcionales; sin ninguno no se avisa nada.

El lanzador de tareas **se niega a usar** este archivo si lo puede leer otro usuario del equipo o no es de `chartbay-datos`.

## 4. La interfaz de revisión

```bash
sudo cp servicio_datos/despliegue/chartbay-revision.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now chartbay-revision
curl -s http://127.0.0.1:8000/salud      # ok
```

Escucha solo en `127.0.0.1`: sin el proxy no es accesible desde afuera, y es lo que permite confiar en lo que el proxy le pasa
(`DATOS_REVISION_PROXY=1`). Un solo worker con hilos, porque el límite de intentos de acceso vive en la memoria del proceso. El
registro de accesos va al diario de systemd (`journalctl -u chartbay-revision`) y no incluye el usuario.

## 5. HTTPS

**Con un dominio y el equipo accesible desde internet** (puertos 80 y 443 abiertos hacia este equipo): Caddy consigue y renueva
solo el certificado de Let's Encrypt, y redirige HTTP a HTTPS.

```bash
# Instalá Caddy 2 (guía de instalación: https://caddyserver.com/docs/install)
sudo cp servicio_datos/despliegue/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/revision.ejemplo.org/TU.DOMINIO.ORG/' /etc/caddy/Caddyfile     # también en DATOS_REVISION_URL
caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
sudo ufw allow 80,443/tcp   # y nada más hacia afuera: el 8000 queda solo para el equipo
```

El registro DNS del dominio tiene que apuntar a este equipo **antes** de arrancar Caddy, o la emisión del certificado falla y
Let's Encrypt limita los reintentos.

**Si el equipo no tiene IP pública** (lo más probable en una red de club): hace falta un túnel que dé HTTPS, como Tailscale
(solo accesible desde tu red privada, que es lo más seguro para una herramienta de administración) o Cloudflare Tunnel. No hay
configuración lista para esos: el servicio sirve igual, solo necesita que quien esté delante pise `X-Forwarded-For`,
`X-Forwarded-Proto` y `X-Forwarded-Host`, mantenga `DATOS_REVISION_PROXY=1` y la app escuchando en `127.0.0.1`. **Nunca** expongas
el puerto 8000 directo ni quites el proxy dejando `DATOS_REVISION_PROXY=1`: cualquiera podría falsear su dirección y esquivar el
límite de intentos.

## 6. Las tareas programadas

```bash
sudo cp servicio_datos/despliegue/chartbay-datos.cron /etc/cron.d/chartbay-datos      # root, 644: cron.d lo exige
sudo chmod 644 /etc/cron.d/chartbay-datos
sudo cp servicio_datos/despliegue/logrotate-chartbay-datos /etc/logrotate.d/chartbay-datos
```

| Tarea | Cuándo (hora de Argentina) | Qué hace |
| --- | --- | --- |
| `ejecutar` | 9:30 y 17:30 | Descarga el IPC, lo valida, y deja un candidato si hay algo nuevo; entrega los avisos que genere. Si no hay nada nuevo, no hace nada |
| `avisar` | cada 4 horas | Detecta y entrega avisos: candidato nuevo, recordatorios, corrida fallida, "no llegó el dato", "el colector no corre" |
| `agente` | cada hora, al minuto 45 | Deja una propuesta fundada junto a cada hallazgo del candidato abierto (sección 7). Sin nada pendiente no usa el modelo |
| `respaldar` | 3:15 | Respalda la base y el crudo en otro disco, verifica lo copiado, ensaya restaurar si hay dónde y poda lo viejo (sección 8) |
| `latido` | cada 10 minutos | Comprueba todo lo de arriba y le avisa al monitor externo que el equipo sigue vivo (sección 9) |

Los últimos tres meses (julio, agosto y septiembre de 2026) INDEC la publicó entre las 15:52 y las 16:08: la corrida de las 17:30 la
encuentra el mismo día. `avisar` corre **aparte** a propósito: los avisos de silencio los detecta quien mira desde afuera, y si el único que mira es la
tarea que murió, no avisa nadie.

El servidor tiene que estar en hora de Argentina (`timedatectl`); `CRON_TZ` lo fuerza en las versiones de cron que lo entienden. Si
no, las horas corren en la del equipo: no se rompe nada, solo cambia a qué hora se enteran del dato.

Cada corrida deja una línea de registro en `/var/log/chartbay-datos/<tarea>.log` con su código de salida y lo que tardó. Si una
corrida anterior sigue andando, la nueva se omite (no es un error). Una corrida colgada se corta a los 20 minutos (`agente` y `respaldar`, a la hora; `latido`, a los 2 minutos).
El lanzador deja además el resultado de la última corrida de cada tarea en `/var/lib/chartbay-datos/chartbay-datos-<tarea>.estado.json`:
es lo que mira el latido para saber si cron sigue corriendo cada una.

## 7. El analista de hallazgos con un modelo local (opcional)

Junto a cada hallazgo de un candidato abierto, el analista deja una propuesta (qué es, qué haría, con qué hechos y con qué
confianza), que la persona ve en la interfaz de revisión. **Solo propone**: no decide ningún hallazgo, no toca el candidato y no
publica. La decisión de la persona sobre el hallazgo resuelve la propuesta, y así queda medido cuánto acierta
(`... servicio_datos.agente estado`).

El modelo corre **en esta misma computadora**: no hay claves ni API en la nube, y lo que se analiza no sale del equipo. Por eso la
dirección tiene que ser `localhost` o `127.0.0.1` (cualquier otra se rechaza).

1. Instalá un servidor de modelos local que hable el protocolo de chat de OpenAI (Ollama, llama.cpp, LM Studio; seguí su guía de
   instalación) y bajá el modelo que quieras probar. Tiene que entrar en la memoria del equipo.
2. En `/etc/chartbay-datos/entorno` definí `DATOS_AGENTE_MODELO` con el nombre del modelo en ese servidor (y `DATOS_AGENTE_URL` si no
   es el puerto 11434 de Ollama). **Sin `DATOS_AGENTE_MODELO` no se usa ningún modelo**: el analista solo repite lo que una persona
   ya decidió sobre un hallazgo idéntico.
3. Medí si el modelo sirve antes de dejarlo trabajar:

   ```bash
   sudo -u chartbay-datos bash -c 'cd /opt/chartbay-datos/repo && /opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea --entorno /etc/chartbay-datos/entorno agente probar'
   ```

   Pasa cinco casos con respuesta conocida por el mismo prompt y validador que usa el analista, y dice cuántos clasificó bien, cuántas
   veces el validador tuvo que corregirle algo y cuánto tarda por caso. Con menos de 4 de 5, las propuestas son ruido: probá con un
   modelo más grande.

Qué hace que se pueda confiar en una propuesta sin confiar en el modelo: el modelo no consulta nada, recibe una lista numerada de
hechos que comprobó el código y solo puede citarlos; el validador descarta citas que no existen, exige para cada clasificación un
hecho de la clase que la sostiene (no puede decir "el archivo está atrasado" si no se comprobó una fecha de archivo) y no deja que la
confianza supere lo que la evidencia permite. Lo que el validador corrige queda anotado en la propuesta.

Si el servidor del modelo no está, el analista no escribe nada de esos hallazgos, corta tras tres fallos seguidos y sale con código
1 (se ve en `agente.log`); la hora siguiente reintenta. Un hallazgo cuya respuesta fue inservible queda marcado como "requiere
revisión humana" y no se reintenta.

## 8. Respaldos de la base y del crudo

Hacen falta los dos, por separado: la base (en el plan gratuito de Supabase no hay copias diarias) y el crudo (los `.xls`
originales; INDEC pisa `sh_ipc_aperturas.xls` cada mes, así que el crudo es la única copia de las versiones anteriores). `respaldar`
corre cada día a las 3:15:

- **Base**: `pg_dump` del esquema `economia` con un rol que solo puede leer. Las filas de cada tabla se cuentan en la misma foto de la
  base que se vuelca y quedan en un manifiesto (`.json`) junto al volcado (`.dump`).
- **Crudo**: copia lo nuevo y verifica todo, original y copia, recalculando el hash que es el nombre de cada archivo. Una copia dañada
  se repone sola; un original dañado o que falta se avisa. De la copia del crudo no se borra nunca nada.
- **Ensayo** (si hay una base local para eso): restaura el volcado del día y compara tabla por tabla con el manifiesto.
- **Conservación**: todos los volcados de los últimos 30 días (`DATOS_RESPALDO_DIAS`) y, de los anteriores, el primero de cada mes.
  Nunca borra el último bueno.
- Cada corrida queda en la tabla `respaldo`. Si una falla, o si pasan dos días sin uno bueno (aunque el cron haya dejado de correr),
  `avisar` lo avisa. El detalle de cada corrida va a `respaldar.log`.

### El disco

`DATOS_RESPALDO_DIR` tiene que estar en **otro disco** que el crudo (un disco USB, otro disco interno, un NAS montado): si están en el
mismo y ese disco falla, se pierden los dos. Montalo por UUID y con `nofail` en `/etc/fstab` (así el equipo arranca aunque el disco no
esté) y creá la carpeta **una sola vez, con el disco montado**:

```bash
sudo mkdir /mnt/respaldo-chartbay/chartbay-datos      # con el disco ya montado en /mnt/respaldo-chartbay
sudo chown chartbay-datos:chartbay-datos /mnt/respaldo-chartbay/chartbay-datos && sudo chmod 700 /mnt/respaldo-chartbay/chartbay-datos
```

El respaldo **no crea** esa carpeta: si el disco no se montó, falla y avisa, en vez de llenar en silencio el disco del sistema. Si
igual quedan en el mismo disco, cada corrida lo advierte.

Esto protege de un disco que se rompe y de un borrado, no de perder el equipo entero (robo, incendio). Para eso hay que sincronizar
`DATOS_RESPALDO_DIR` con otro lugar (por ejemplo con rclone o restic a un almacenamiento externo); eso no está armado ni probado.

### El rol de solo lectura

`pg_dump` necesita leer todo el esquema, también `schema_migrations`, que `datos_escritura` no puede leer a propósito. El respaldo usa
un rol propio que solo lee. Lo crea el administrador, una vez:

```bash
python -m servicio_datos.respaldar sql-del-rol     # imprime el SQL, sin ninguna clave
psql "postgresql://postgres.PROJECT_REF@HOST_DEL_POOLER:5432/postgres?sslmode=require"     # pide la clave del administrador
```

En psql se pega ese SQL y después `\password datos_respaldo`, que pide la clave nueva sin que quede escrita en ningún lado. La URL va
en `DATOS_RESPALDO_DATABASE_URL`, con el usuario `datos_respaldo.PROJECT_REF`. Después de cada migración nueva hay que repetir los dos
`GRANT SELECT` (igual que se repite `preparar_supabase` para los otros roles); si no, el respaldo falla diciendo qué tabla no puede leer.

### pg_dump de la versión del servidor

`pg_dump` tiene que ser de la misma versión mayor que el PostgreSQL de Supabase, o más nueva. El respaldo lo comprueba y, si no, falla
diciendo qué instalar. El de Ubuntu puede quedar viejo: instalá `postgresql-client-N` (N es la versión del servidor, que muestra el
panel de Supabase) desde el repositorio oficial de PostgreSQL ([instrucciones](https://www.postgresql.org/download/linux/ubuntu/)). Si
queda más de una versión instalada, indicá la carpeta en `DATOS_PG_BIN` (por ejemplo `/usr/lib/postgresql/17/bin`).

### El ensayo de restauración (recomendado)

Un respaldo que nunca se restauró es una esperanza, no un respaldo. Con un PostgreSQL local y una base vacía dedicada, cada corrida
restaura el volcado nuevo y compara:

```bash
sudo apt install postgresql-N         # el servidor, de la misma versión que el cliente
sudo -u postgres createuser chartbay-datos
sudo -u postgres createdb -O chartbay-datos chartbay_ensayo
```

y en el entorno `DATOS_RESPALDO_ENSAYO_URL=postgresql:///chartbay_ensayo?host=/var/run/postgresql` (socket local, sin clave). El
ensayo solo acepta una base de este equipo, nunca la del servicio, y solo borra el esquema que creó él mismo la vez anterior. Para
correrlo a mano: `... servicio_datos.tarea --entorno /etc/chartbay-datos/entorno respaldar ensayar`.

### Restaurar

- **El crudo** (se perdió o se dañó la carpeta): con `DATOS_CRUDO_DIR` apuntando a la carpeta, vacía o dañada,
  `... respaldar restaurar-crudo` devuelve lo que falte o esté dañado, y solo desde copias que coinciden con su hash.
- **La base** (se perdió el proyecto o los datos): en un proyecto nuevo, como administrador y sin la clave en la URL (la pide):

  ```bash
  psql "postgresql://postgres.PROJECT_REF@HOST:5432/postgres?sslmode=require" -c "CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public"
  pg_restore --no-owner --no-acl --exit-on-error -d "postgresql://postgres.PROJECT_REF@HOST:5432/postgres?sslmode=require" \
    /mnt/respaldo-chartbay/chartbay-datos/base/economia-AAAAMMDDTHHMMSSZ.dump
  ```

  Restaura el esquema `economia` entero, con su registro de migraciones. Después `preparar_supabase` recrea los roles y sus permisos
  sin volver a migrar (ver `despliegue-supabase.md`) y `sql-del-rol`, el del respaldo. Esto no se probó contra Supabase: lo probado es
  restaurar en un PostgreSQL 17 local, que es lo mismo que hace el ensayo.

## 9. El monitor externo: el latido

Lo que corre en el equipo no puede avisar que el equipo se apagó, que se cortó la red o que cron dejó de correr: el que tendría que
avisar es justo lo que se cayó. Por eso el control se da vuelta. Cada 10 minutos el equipo **late**: le manda a un servicio de afuera
un "sigo vivo" con el detalle de cómo está. Si los latidos dejan de llegar, el servicio de afuera avisa por su cuenta. Funciona aunque
la interfaz de revisión solo sea accesible por una red privada (Tailscale): no hace falta que nadie de afuera llegue al equipo.

Antes de latir comprueba:

| Qué | Falla si |
| --- | --- |
| revisión local | `/salud` no responde «ok» en `127.0.0.1:8000` |
| revisión pública | `DATOS_REVISION_URL` no responde por HTTPS, o el certificado vence en menos de 7 días (menos de 21: advertencia) |
| base | no responde (también si Supabase pausó el proyecto) |
| avisos entregados | hay avisos que no se pueden entregar: Slack o el correo fallan, y el latido es lo único que sale |
| tareas | `ejecutar`, `avisar` o `respaldar` no corrieron a tiempo, o fallaron 3 veces seguidas (`agente` solo da advertencias) |
| discos | el disco de respaldo no está montado, o queda menos de 1 GB libre (menos de 5 GB: advertencia) |

Si algo falla, late "con falla" (`/fail`, el protocolo de Healthchecks) y el servicio avisa enseguida, con el detalle. Las
advertencias van en el detalle de un latido normal.

1. Creá una cuenta en [Healthchecks.io](https://healthchecks.io) (o usá uno propio: es software libre) y un chequeo con período de
   10 minutos y un margen de gracia de 20. Elegí cómo te avisa: correo, Telegram, Slack... Mejor por un camino distinto del de los
   avisos del servicio: si el que se rompe es ese, este tiene que llegar igual.
2. Copiá su dirección de latido (`https://hc-ping.com/...`) en `DATOS_MONITOR_URL`. Es una credencial: va solo en el archivo de entorno.
3. Probalo:

   ```bash
   sudo -u chartbay-datos bash -c 'cd /opt/chartbay-datos/repo && /opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea --entorno /etc/chartbay-datos/entorno latido probar'
   sudo -u chartbay-datos bash -c 'cd /opt/chartbay-datos/repo && /opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea --entorno /etc/chartbay-datos/entorno latido estado'
   ```

   `probar` manda un latido de prueba (tiene que aparecer en el panel de Healthchecks); `estado` muestra todas las comprobaciones sin
   latir. Recién instalado, las tareas que todavía no corrieron salen como advertencia; al día siguiente tienen que estar todas en ✓.

Con todo bien, `latido.log` guarda una línea por latido; con algo mal, el detalle entero. Si la interfaz es pública, se puede sumar
un monitor de disponibilidad desde afuera sobre `https://TU.DOMINIO.ORG/salud` (prueba el camino desde internet), pero no reemplaza
al latido: no sabe nada de la base, de cron ni del disco.

## Lista de comprobación al instalar

```bash
# 1. La base y los permisos
sudo -u chartbay-datos /opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea --entorno /etc/chartbay-datos/entorno avisar
#    → debe terminar sin error (si falta migrar la base, se queja de una tabla: ver despliegue-supabase.md)

# 2. Una corrida a mano, con el mismo lanzador que usa cron
sudo -u chartbay-datos bash -c 'cd /opt/chartbay-datos/repo && /opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea --entorno /etc/chartbay-datos/entorno ejecutar'

# 3. Los canales de avisos
sudo -u chartbay-datos bash -c 'cd /opt/chartbay-datos/repo && /opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea --entorno /etc/chartbay-datos/entorno avisar probar'

# 4. El modelo local (solo si configuraste DATOS_AGENTE_MODELO)
sudo -u chartbay-datos bash -c 'cd /opt/chartbay-datos/repo && /opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea --entorno /etc/chartbay-datos/entorno agente probar'

# 5. El respaldo (con el disco montado, la carpeta creada y el rol de solo lectura)
sudo -u chartbay-datos bash -c 'cd /opt/chartbay-datos/repo && /opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea --entorno /etc/chartbay-datos/entorno respaldar'
sudo -u chartbay-datos bash -c 'cd /opt/chartbay-datos/repo && /opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea --entorno /etc/chartbay-datos/entorno respaldar estado'

# 6. El latido (con DATOS_MONITOR_URL puesto)
sudo -u chartbay-datos bash -c 'cd /opt/chartbay-datos/repo && /opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea --entorno /etc/chartbay-datos/entorno latido probar'

# 7. HTTPS desde afuera
curl -sI http://TU.DOMINIO.ORG/              # 308 hacia https
curl -sI https://TU.DOMINIO.ORG/             # 401 con www-authenticate (sin credenciales no se ve nada)
curl -sI -u USUARIO https://TU.DOMINIO.ORG/  # 200 y strict-transport-security
curl -s https://TU.DOMINIO.ORG/salud         # ok
```

Y en el equipo: `systemctl status chartbay-revision`, `ls -l /etc/chartbay-datos/entorno` (debe ser `-rw------- chartbay-datos`),
`ss -tlnp | grep 8000` (solo `127.0.0.1`), y esperar a la primera corrida de cron para mirar `ejecutar.log`.

## Operación

- **Actualizar**: `git pull` en `/opt/chartbay-datos/repo`, `pip install -r servicio_datos/requirements.txt`, y
  `sudo systemctl restart chartbay-revision`. Si hay migraciones nuevas, **antes** aplicalas con el comando del administrador de
  `despliegue-supabase.md` (el usuario de este servicio no puede migrar a propósito).
- **Registros**: `journalctl -u chartbay-revision` (interfaz) y `/var/log/chartbay-datos/*.log` (tareas). El estado de los avisos:
  `... servicio_datos.tarea --entorno /etc/chartbay-datos/entorno avisar estado`. Las propuestas del analista:
  `... servicio_datos.tarea --entorno /etc/chartbay-datos/entorno agente estado`.
- **Respaldos**: automáticos, ver la sección 8. Cómo vienen: `... servicio_datos.tarea --entorno /etc/chartbay-datos/entorno respaldar estado`.
  Las claves (`/etc/chartbay-datos/entorno`) no se respaldan acá, a propósito: guardalas en un gestor de contraseñas.
- **Cómo está todo**: `... servicio_datos.tarea --entorno /etc/chartbay-datos/entorno latido estado`, y el panel del monitor externo.
- **Una corrida fallida** no se reintenta sola: se ve en la cola de la interfaz y llega un aviso; cuando se arregla la causa, se
  corre `ejecutar` a mano (el comando del punto 2).

## Límites conocidos

- Si el servidor, la red o la base (Supabase pausa los proyectos gratuitos tras 7 días sin actividad) se caen, `avisar` no puede
  avisar: eso lo cubre el latido (sección 9), y solo si `DATOS_MONITOR_URL` está puesto. `/salud` responde sin consultar la base:
  dice que el proceso vive; la base la comprueba el latido.
- El latido no ve lo que pasa entre dos latidos ni lo que no comprueba: que una corrida haya leído mal un archivo, por ejemplo, es
  cosa de los hallazgos y de la revisión, no del monitor.
- Acceso con usuario y contraseña (HTTP Basic): sirve para pocos revisores. No tiene recuperación de contraseña ni segundo factor.
- El límite de intentos de acceso vive en la memoria del servicio: se reinicia con él.
