"""Respaldo de la base y del crudo, verificado y con ensayo de restauración.

Hacen falta los dos: la base sola no reconstruye una descarga (los .xls originales viven en el crudo, y INDEC pisa algunos
cada mes) y el crudo solo no dice qué se revisó ni qué se publicó. El plan gratuito de Supabase no hace copias diarias.

- **Base**: `pg_dump` del esquema del servicio, en formato de `pg_restore`. Se toma sobre la misma foto de la base (snapshot)
  en la que se cuentan las filas de cada tabla; esas cuentas y las migraciones aplicadas van en un manifiesto al lado del
  volcado, para que el ensayo pueda comparar lo restaurado con lo que había.
- **Crudo**: copia lo nuevo y verifica TODO en cada corrida, en el original y en la copia. El nombre de cada archivo es el
  hash de su contenido, así que verificar es recalcularlo. Una copia dañada se repone; un original dañado o que falta se
  informa, y `restaurar_crudo` lo recupera de la copia. De la copia del crudo no se borra nunca nada.
- **Ensayo**: restaura el último volcado en una base de ESTE equipo, dedicada a eso, y compara tabla por tabla. Un respaldo
  que nunca se restauró es una esperanza, no un respaldo.
- **Conservación**: todos los volcados de los últimos días y, de los más viejos, el primero de cada mes. Nunca el último bueno.

La clave de la base nunca va en la línea de comandos de pg_dump (cualquier usuario del equipo la vería con `ps`): va en
variables de entorno del proceso, que solo ve el mismo usuario. Los errores no la repiten.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Mapping

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

DIAS_POR_DEFECTO = 30
LIMITE_PG_SEGUNDOS = 1800
LOCALES = ("localhost", "127.0.0.1", "::1")
MARCA_ENSAYO = "Restauración de ensayo del servicio de datos de ChartBay: se borra y se vuelve a crear en cada ensayo."
CRUDO = re.compile(r"^([0-9a-f]{2})/([0-9a-f]{64})\.[a-z0-9]{1,5}$")
VOLCADO = re.compile(r"^(?P<esquema>[a-z_][a-z0-9_]*)-(?P<momento>\d{8}T\d{6}Z)\.dump$")
# Cómo se le pasa a pg_dump cada parámetro de la URL sin ponerlo en la línea de comandos.
LIBPQ_ENTORNO: Mapping[str, str] = {
    "host": "PGHOST", "hostaddr": "PGHOSTADDR", "port": "PGPORT", "dbname": "PGDATABASE", "user": "PGUSER", "password": "PGPASSWORD",
    "sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT", "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY", "channel_binding": "PGCHANNELBINDING",
    "connect_timeout": "PGCONNECT_TIMEOUT", "options": "PGOPTIONS", "application_name": "PGAPPNAME", "target_session_attrs": "PGTARGETSESSIONATTRS",
}


class ErrorRespaldo(Exception):
    """Algo del respaldo no salió. El mensaje no incluye claves."""


# --- Conexión con los programas de PostgreSQL -----------------------------------------------------

def entorno_libpq(url: str) -> dict[str, str]:
    """Las variables PG* que equivalen a la URL. Un parámetro que no se sabe pasar se rechaza: no se lo descarta en silencio."""
    try:
        parametros = conninfo_to_dict(url)
    except psycopg.Error:
        raise ErrorRespaldo("La URL de la base no se entiende") from None
    desconocidos = sorted(set(parametros) - set(LIBPQ_ENTORNO))
    if desconocidos:
        raise ErrorRespaldo(f"La URL trae parámetros que el respaldo no sabe pasarle a pg_dump: {', '.join(desconocidos)}")
    return {LIBPQ_ENTORNO[clave]: str(valor) for clave, valor in parametros.items() if valor not in (None, "")}


def _programa(nombre: str, pg_bin: str | None) -> str:
    return str(Path(pg_bin) / nombre) if pg_bin else (shutil.which(nombre) or nombre)


def _correr(comando: list[str], entorno_pg: Mapping[str, str], limite: float = LIMITE_PG_SEGUNDOS) -> subprocess.CompletedProcess:
    nombre = Path(comando[0]).name
    base = {k: v for k, v in os.environ.items() if not k.startswith("PG")}  # que no se cuele otra base por el entorno heredado
    try:
        proceso = subprocess.run(comando, env={**base, **entorno_pg}, capture_output=True, text=True, timeout=limite)
    except FileNotFoundError:
        raise ErrorRespaldo(f"No se encontró {nombre}: instalá el cliente de PostgreSQL o indicá su carpeta en DATOS_PG_BIN") from None
    except subprocess.TimeoutExpired:
        raise ErrorRespaldo(f"{nombre} no terminó en {int(limite)} s") from None
    if proceso.returncode != 0:
        detalle = " ".join((proceso.stderr or "").strip().splitlines()[-3:])
        clave = entorno_pg.get("PGPASSWORD")
        if clave:
            detalle = detalle.replace(clave, "***")
        raise ErrorRespaldo(f"{nombre} falló (código {proceso.returncode}): {detalle[:500] or 'sin detalle'}")
    return proceso


def version_mayor(programa: str) -> int:
    salida = _correr([programa, "--version"], {}, limite=30).stdout
    coincide = re.search(r"\)\s*(\d+)", salida)
    if not coincide:
        raise ErrorRespaldo(f"No se entiende la versión de {Path(programa).name}: {salida.strip()[:80]}")
    return int(coincide.group(1))


# --- Archivos ----------------------------------------------------------------------------------------

def _hash(ruta: Path) -> str:
    digesto = hashlib.sha256()
    with open(ruta, "rb") as archivo:
        for bloque in iter(lambda: archivo.read(1 << 20), b""):
            digesto.update(bloque)
    return digesto.hexdigest()


def _sincronizar(ruta: Path) -> None:
    with open(ruta, "rb") as archivo:
        os.fsync(archivo.fileno())


def _copiar_verificado(origen: Path, destino: Path, esperado: str) -> None:
    """Copia a un temporal, lo relee y recién si el hash coincide lo pone en su lugar: nunca queda una copia a medias."""
    destino.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporal = tempfile.mkstemp(dir=destino.parent, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as salida, open(origen, "rb") as entrada:
            shutil.copyfileobj(entrada, salida, 1 << 20)
            salida.flush()
            os.fsync(salida.fileno())
        if _hash(Path(temporal)) != esperado:
            raise ErrorRespaldo(f"La copia de {destino.name} no coincide con el original: ¿falla el disco de destino?")
        os.chmod(temporal, 0o444)
        os.replace(temporal, destino)
    except BaseException:
        Path(temporal).unlink(missing_ok=True)
        raise


def archivos_de_crudo(carpeta: Path) -> dict[str, Path]:
    """Los archivos con nombre de crudo (`ab/ab12…ef.xls`), por ruta relativa. Lo demás (temporales, ajenos) se ignora."""
    if not carpeta.is_dir():
        return {}
    encontrados = {}
    for ruta in carpeta.glob("*/*"):
        relativa = ruta.relative_to(carpeta).as_posix()
        coincide = CRUDO.match(relativa)
        if coincide and coincide.group(2).startswith(coincide.group(1)) and ruta.is_file():
            encontrados[relativa] = ruta
    return encontrados


# --- Base -------------------------------------------------------------------------------------------

def _esquema_del_servicio(conn: psycopg.Connection) -> str:
    fila = conn.execute("SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('schema_migrations')").fetchone()
    if fila is None:
        raise ErrorRespaldo("No se encontró schema_migrations en el search_path de la conexión: ¿es la base del servicio?")
    return fila[0]


def _cuentas(conn: psycopg.Connection, esquema: str) -> tuple[dict[str, int], list[str]]:
    tablas = [t for (t,) in conn.execute(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = %s AND c.relkind IN ('r', 'p') ORDER BY 1", (esquema,))]
    cuentas = {}
    for tabla in tablas:
        try:
            cuentas[tabla] = conn.execute(sql.SQL("SELECT count(*) FROM {}.{}").format(sql.Identifier(esquema), sql.Identifier(tabla))).fetchone()[0]
        except psycopg.errors.InsufficientPrivilege:
            raise ErrorRespaldo(f"El rol del respaldo no puede leer {esquema}.{tabla}: tiene que poder leer todo el esquema (ver la guía de despliegue)") from None
    migraciones = [v for (v,) in conn.execute(sql.SQL("SELECT version FROM {}.schema_migrations ORDER BY version").format(sql.Identifier(esquema)))]
    return cuentas, migraciones


def respaldar_base(url: str, carpeta: Path, ahora: datetime, *, pg_bin: str | None = None) -> tuple[Path, dict]:
    """Vuelca el esquema del servicio y deja al lado su manifiesto. Devuelve (volcado, manifiesto)."""
    entorno = entorno_libpq(url)
    pg_dump, pg_restore = _programa("pg_dump", pg_bin), _programa("pg_restore", pg_bin)
    carpeta.mkdir(parents=True, exist_ok=True)
    os.chmod(carpeta, 0o700)
    cliente = version_mayor(pg_dump)
    with psycopg.connect(url) as conn:
        # Una sola foto para las cuentas y para pg_dump: lo que dice el manifiesto es exactamente lo que se volcó.
        conn.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        conn.read_only = True
        esquema = _esquema_del_servicio(conn)
        servidor = conn.info.server_version // 10000
        if cliente < servidor:
            raise ErrorRespaldo(f"pg_dump {cliente} no puede respaldar PostgreSQL {servidor}: instalá postgresql-client-{servidor} o uno más nuevo")
        foto = conn.execute("SELECT pg_export_snapshot()").fetchone()[0]
        cuentas, migraciones = _cuentas(conn, esquema)
        nombre = f"{esquema}-{ahora.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"
        volcado, temporal = carpeta / f"{nombre}.dump", carpeta / f"{nombre}.dump.tmp"
        try:
            _correr([pg_dump, "--format=custom", f"--schema={esquema}", f"--snapshot={foto}", "--no-password", "--lock-wait-timeout=60s",
                     f"--file={temporal}"], entorno)
        except BaseException:
            temporal.unlink(missing_ok=True)
            raise
    try:
        # Que pg_restore lo pueda leer y que traiga los datos de cada tabla contada.
        listado = _correr([pg_restore, "--list", str(temporal)], {}).stdout
        faltan = [t for t in cuentas if not re.search(rf"\bTABLE DATA {re.escape(esquema)} {re.escape(t)}\b", listado)]
        if faltan:
            raise ErrorRespaldo(f"El volcado no trae los datos de: {', '.join(faltan)}")
        _sincronizar(temporal)
        os.chmod(temporal, 0o600)
        manifiesto = {"esquema": esquema, "creado_en": ahora.astimezone(timezone.utc).isoformat(timespec="seconds"), "tablas": cuentas,
                      "migraciones": migraciones, "bytes": temporal.stat().st_size, "sha256": _hash(temporal), "pg_dump": cliente, "servidor": servidor}
        _escribir_json(carpeta / f"{nombre}.json", manifiesto)  # primero el manifiesto: un volcado sin manifiesto se trata como incompleto
        os.replace(temporal, volcado)
    except BaseException:
        temporal.unlink(missing_ok=True)
        (carpeta / f"{nombre}.json").unlink(missing_ok=True)
        raise
    return volcado, manifiesto


def _escribir_json(destino: Path, contenido: dict) -> None:
    descriptor, temporal = tempfile.mkstemp(dir=destino.parent, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as archivo:
            json.dump(contenido, archivo, ensure_ascii=False, indent=1)
            archivo.flush()
            os.fsync(archivo.fileno())
        os.chmod(temporal, 0o600)
        os.replace(temporal, destino)
    except BaseException:
        Path(temporal).unlink(missing_ok=True)
        raise


def volcados(carpeta: Path) -> list[tuple[datetime, Path]]:
    """Los volcados completos (con manifiesto), del más viejo al más nuevo."""
    encontrados = []
    for ruta in carpeta.glob("*.dump") if carpeta.is_dir() else ():
        coincide = VOLCADO.match(ruta.name)
        if coincide and ruta.with_suffix(".json").is_file():
            encontrados.append((datetime.strptime(coincide["momento"], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc), ruta))
    return sorted(encontrados)


def podar(carpeta: Path, ahora: datetime, dias: int = DIAS_POR_DEFECTO) -> list[str]:
    """Borra los volcados que sobran y los restos de corridas cortadas. Devuelve lo que borró."""
    borrados = []
    for ruta in carpeta.glob("*") if carpeta.is_dir() else ():
        incompleto = ruta.suffix == ".tmp" or (VOLCADO.match(ruta.name) and not ruta.with_suffix(".json").is_file())
        if incompleto and ahora.timestamp() - ruta.stat().st_mtime > 86400:  # uno reciente puede ser de una corrida en curso
            ruta.unlink()
            borrados.append(ruta.name)
    completos = volcados(carpeta)
    if not completos:
        return borrados
    conservar, meses = {completos[-1][1]}, set()
    for momento, ruta in completos:
        if ahora - momento <= timedelta(days=dias):
            conservar.add(ruta)
        elif (momento.year, momento.month) not in meses:  # de los viejos, el primero de cada mes
            meses.add((momento.year, momento.month))
            conservar.add(ruta)
    for _, ruta in completos:
        if ruta not in conservar:
            ruta.unlink()
            ruta.with_suffix(".json").unlink(missing_ok=True)
            borrados.append(ruta.name)
    return borrados


# --- Crudo ------------------------------------------------------------------------------------------

@dataclass
class ResultadoCrudo:
    archivos: int = 0  # originales con nombre de crudo
    copiados: int = 0
    reparados: int = 0  # copias dañadas que se volvieron a copiar
    danados_origen: list[str] = field(default_factory=list)  # el original no coincide con su hash: no se copia encima de una copia buena
    faltan_en_origen: list[str] = field(default_factory=list)  # la base los nombra y solo están en la copia (recuperables)
    perdidos: list[str] = field(default_factory=list)  # la base los nombra y no están en ningún lado

    @property
    def ok(self) -> bool:
        return not (self.danados_origen or self.faltan_en_origen or self.perdidos)


def respaldar_crudo(origen: Path, destino: Path, esperados: Iterable[str] = ()) -> ResultadoCrudo:
    if not origen.is_dir():
        raise ErrorRespaldo(f"No existe la carpeta del crudo {origen}")
    resultado = ResultadoCrudo()
    originales, copias = archivos_de_crudo(origen), archivos_de_crudo(destino)
    resultado.archivos = len(originales)
    for relativa, ruta in sorted(originales.items()):
        esperado = CRUDO.match(relativa).group(2)
        if _hash(ruta) != esperado:
            resultado.danados_origen.append(relativa)
            continue
        copia = copias.get(relativa)
        if copia is None:
            _copiar_verificado(ruta, destino / relativa, esperado)
            resultado.copiados += 1
        elif _hash(copia) != esperado:
            _copiar_verificado(ruta, destino / relativa, esperado)
            resultado.reparados += 1
    for relativa in sorted(set(esperados) - set(originales)):
        (resultado.faltan_en_origen if relativa in copias else resultado.perdidos).append(relativa)
    return resultado


def restaurar_crudo(destino: Path, origen: Path) -> dict:
    """Devuelve al crudo, desde la copia, lo que falte o esté dañado. Solo con copias que coinciden con su hash."""
    restaurados, danados_copia, ya_estaban = [], [], 0
    for relativa, copia in sorted(archivos_de_crudo(destino).items()):
        esperado = CRUDO.match(relativa).group(2)
        actual = origen / relativa
        if actual.is_file() and _hash(actual) == esperado:
            ya_estaban += 1
        elif _hash(copia) != esperado:
            danados_copia.append(relativa)
        else:
            _copiar_verificado(copia, actual, esperado)
            restaurados.append(relativa)
    return {"restaurados": restaurados, "ya_estaban": ya_estaban, "danados_en_la_copia": danados_copia}


# --- Ensayo -----------------------------------------------------------------------------------------

def _es_local(parametros: Mapping[str, str]) -> bool:
    host, direccion = parametros.get("host") or "", parametros.get("hostaddr") or ""
    return (host == "" or host.startswith("/") or host in LOCALES) and direccion in ("", "127.0.0.1", "::1")


def _destino(parametros: Mapping[str, str]) -> tuple[str, str, str]:
    return (parametros.get("host") or "", parametros.get("port") or "5432", parametros.get("dbname") or parametros.get("user") or "")


def ensayar(url_ensayo: str, volcado: Path, *, url_produccion: str | None = None, pg_bin: str | None = None) -> dict:
    """Restaura el volcado en una base local de ensayo y comprueba que quedó lo mismo que había al volcarlo."""
    try:
        parametros = conninfo_to_dict(url_ensayo)
    except psycopg.Error:
        raise ErrorRespaldo("La URL de la base de ensayo no se entiende") from None
    if not _es_local(parametros):
        raise ErrorRespaldo("El ensayo restaura en una base de ESTE equipo: la dirección tiene que ser localhost, 127.0.0.1, ::1 o un socket local")
    if not parametros.get("dbname"):
        raise ErrorRespaldo("La URL de ensayo tiene que nombrar la base de ensayo")
    if url_produccion and _destino(conninfo_to_dict(url_produccion)) == _destino(parametros):
        raise ErrorRespaldo("La base de ensayo es la misma que la del servicio: el ensayo borra su esquema, usá una base dedicada")
    manifiesto = json.loads(volcado.with_suffix(".json").read_text(encoding="utf-8"))
    if _hash(volcado) != manifiesto["sha256"]:
        raise ErrorRespaldo(f"El volcado {volcado.name} está dañado: su hash no coincide con el del manifiesto")
    esquema = manifiesto["esquema"]
    with psycopg.connect(url_ensayo, autocommit=True) as conn:
        fila = conn.execute("SELECT obj_description(oid, 'pg_namespace') FROM pg_namespace WHERE nspname = %s", (esquema,)).fetchone()
        if fila and fila[0] != MARCA_ENSAYO:
            raise ErrorRespaldo(f"En la base de ensayo ya hay un esquema {esquema} que no creó un ensayo: no se toca. Usá una base vacía, dedicada al ensayo")
        if fila:
            conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(esquema)))
        conn.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")  # la exclusión de solapes la necesita; el volcado del esquema no la trae
    entorno = entorno_libpq(url_ensayo)
    _correr([_programa("pg_restore", pg_bin), "--no-owner", "--no-acl", "--single-transaction", "--exit-on-error", "--no-password",
             f"--dbname={entorno['PGDATABASE']}", str(volcado)], entorno)
    with psycopg.connect(url_ensayo, autocommit=True) as conn:
        conn.execute(sql.SQL("COMMENT ON SCHEMA {} IS {}").format(sql.Identifier(esquema), sql.Literal(MARCA_ENSAYO)))
        cuentas, migraciones = _cuentas(conn, esquema)
    distintas = {t: (manifiesto["tablas"].get(t), cuentas.get(t)) for t in sorted(set(manifiesto["tablas"]) | set(cuentas))
                 if manifiesto["tablas"].get(t) != cuentas.get(t)}
    if distintas:
        raise ErrorRespaldo("Lo restaurado no coincide con lo volcado (tabla: volcado → restaurado): "
                            + ", ".join(f"{t}: {a} → {b}" for t, (a, b) in distintas.items()))
    if migraciones != manifiesto["migraciones"]:
        raise ErrorRespaldo("Las migraciones restauradas no coinciden con las del volcado")
    return {"volcado": volcado.name, "tablas": len(cuentas), "filas": sum(cuentas.values())}


# --- El rol del respaldo ----------------------------------------------------------------------------

NOMBRE_SQL = re.compile(r"^[a-z_][a-z0-9_]*$")


def sql_del_rol(rol: str = "datos_respaldo", esquema: str = "economia", base: str = "postgres") -> str:
    """El SQL que crea un rol que puede leer todo el esquema y nada más: es lo que necesita pg_dump. Sin clave."""
    for nombre in (rol, esquema, base):
        if not NOMBRE_SQL.match(nombre):
            raise ValueError(f"Nombre inválido para SQL: {nombre!r}")
    return (f"-- Rol de solo lectura para el respaldo (pg_dump). Lo corre el administrador de la base, una vez.\n"
            f"-- La clave se pone después, en psql, con \\password {rol}: así no queda escrita en ningún historial.\n"
            f"CREATE ROLE {rol} WITH LOGIN NOINHERIT;\n"
            f"GRANT USAGE ON SCHEMA {esquema} TO {rol};\n"
            f"GRANT SELECT ON ALL TABLES IN SCHEMA {esquema} TO {rol};\n"
            f"GRANT SELECT ON ALL SEQUENCES IN SCHEMA {esquema} TO {rol};\n"
            f"ALTER ROLE {rol} IN DATABASE {base} SET search_path TO {esquema}, extensions;\n"
            f"-- Después de cada migración nueva, repetir los dos GRANT SELECT: valen para las tablas que ya existen.\n")


# --- Todo junto -------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Configuracion:
    destino: Path  # DATOS_RESPALDO_DIR: en OTRO disco que el crudo
    crudo: Path | None  # DATOS_CRUDO_DIR
    url_volcado: str | None  # DATOS_RESPALDO_DATABASE_URL: un rol que pueda leer todo el esquema
    url_registro: str | None  # DATOS_DATABASE_URL: para anotar el resultado y saber qué crudos nombra la base
    url_ensayo: str | None = None  # DATOS_RESPALDO_ENSAYO_URL: base local, dedicada al ensayo
    dias: int = DIAS_POR_DEFECTO
    pg_bin: str | None = None  # DATOS_PG_BIN: carpeta de pg_dump/pg_restore si no son los del PATH


def configuracion_desde_entorno(env: Mapping[str, str]) -> Configuracion:
    destino = (env.get("DATOS_RESPALDO_DIR") or "").strip()
    if not destino:
        raise ValueError("Falta DATOS_RESPALDO_DIR: la carpeta donde se guardan los respaldos (en otro disco que el crudo)")
    if not Path(destino).is_absolute():
        raise ValueError("DATOS_RESPALDO_DIR tiene que ser una ruta absoluta")
    dias = (env.get("DATOS_RESPALDO_DIAS") or str(DIAS_POR_DEFECTO)).strip()
    if not dias.isdigit() or not 1 <= int(dias) <= 3650:
        raise ValueError("DATOS_RESPALDO_DIAS tiene que ser un número de días entre 1 y 3650")
    texto = lambda nombre: (env.get(nombre) or "").strip() or None  # noqa: E731
    crudo = texto("DATOS_CRUDO_DIR")
    return Configuracion(Path(destino), Path(crudo) if crudo else None, texto("DATOS_RESPALDO_DATABASE_URL"), texto("DATOS_DATABASE_URL"),
                         texto("DATOS_RESPALDO_ENSAYO_URL"), int(dias), texto("DATOS_PG_BIN"))


def _crudos_esperados(url: str) -> list[str]:
    with psycopg.connect(url, autocommit=True) as conn:
        return [r for (r,) in conn.execute("SELECT DISTINCT ruta_crudo FROM descarga WHERE estado <> 'fallida' AND ruta_crudo IS NOT NULL")]


def respaldar(conf: Configuracion, ahora: datetime) -> tuple[bool, dict]:
    """Base, crudo y (si hay dónde) ensayo. Una parte que falla no frena a las otras. Devuelve (todo bien, resumen)."""
    errores, avisos, resumen = [], [], {"destino": str(conf.destino)}
    if not conf.destino.is_dir():
        # No se crea sola: si el disco de respaldo no se montó, crearla llenaría en silencio el disco del sistema, el mismo del crudo.
        errores.append(f"No existe DATOS_RESPALDO_DIR ({conf.destino}): ¿está montado el disco de respaldo? Se crea una sola vez, al instalar")
        return False, {**resumen, "avisos": avisos, "errores": errores}
    volcado = None
    if not conf.url_volcado:
        errores.append("Base: falta DATOS_RESPALDO_DATABASE_URL (un rol que pueda leer todo el esquema; ver la guía de despliegue)")
    else:
        try:
            volcado, manifiesto = respaldar_base(conf.url_volcado, conf.destino / "base", ahora, pg_bin=conf.pg_bin)
            resumen["base"] = {"archivo": volcado.name, "bytes": manifiesto["bytes"], "sha256": manifiesto["sha256"],
                               "tablas": len(manifiesto["tablas"]), "filas": sum(manifiesto["tablas"].values())}
        except (ErrorRespaldo, psycopg.Error, OSError) as error:
            errores.append(f"Base: {error}")

    if conf.crudo is None:
        errores.append("Crudo: falta DATOS_CRUDO_DIR")
    else:
        esperados: list[str] = []
        if conf.url_registro:
            try:
                esperados = _crudos_esperados(conf.url_registro)
            except psycopg.Error as error:
                avisos.append(f"No se pudo leer de la base qué archivos del crudo deberían existir ({type(error).__name__}): se copió lo que hay")
        try:
            crudo = respaldar_crudo(conf.crudo, conf.destino / "crudo", esperados)
            resumen["crudo"] = asdict(crudo)
            for clave, texto in (("danados_origen", "originales dañados"), ("faltan_en_origen", "faltan en el crudo y están en la copia (restaurar-crudo los recupera)"),
                                 ("perdidos", "faltan en el crudo y en la copia")):
                if getattr(crudo, clave):
                    errores.append(f"Crudo: {len(getattr(crudo, clave))} {texto}: {', '.join(getattr(crudo, clave)[:5])}")
            if conf.crudo.is_dir() and conf.destino.is_dir() and os.stat(conf.crudo).st_dev == os.stat(conf.destino).st_dev:
                avisos.append("El respaldo está en el mismo disco que el crudo: si ese disco falla, se pierden los dos")
        except (ErrorRespaldo, OSError) as error:
            errores.append(f"Crudo: {error}")

    if volcado and conf.url_ensayo:
        try:
            resumen["ensayo"] = ensayar(conf.url_ensayo, volcado, url_produccion=conf.url_registro, pg_bin=conf.pg_bin)
        except (ErrorRespaldo, psycopg.Error, OSError) as error:
            errores.append(f"Ensayo: {error}")
    elif not conf.url_ensayo:
        avisos.append("No hay base de ensayo (DATOS_RESPALDO_ENSAYO_URL): el volcado se verifica, pero no se ensaya restaurarlo")

    if volcado:  # solo se poda si hay uno nuevo y bueno
        resumen["borrados"] = podar(conf.destino / "base", ahora, conf.dias)
    resumen["avisos"], resumen["errores"] = avisos, errores
    return not errores, resumen
