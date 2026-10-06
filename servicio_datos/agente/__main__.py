"""El analista de hallazgos, desde la terminal.

    python -m servicio_datos.agente            # analiza los candidatos abiertos y deja propuestas (apto para un cron)
    python -m servicio_datos.agente probar     # mide si el modelo local sirve: unos casos con respuesta conocida
    python -m servicio_datos.agente estado     # qué propuestas hay y cuánto coincidió con lo que decidieron las personas

El modelo corre en esta misma computadora (Ollama, llama.cpp, LM Studio...) y se configura por entorno; sin
DATOS_AGENTE_MODELO el analista solo repite decisiones previas de las personas sobre hallazgos idénticos:

    DATOS_AGENTE_MODELO     nombre del modelo en el servidor local (por ejemplo qwen2.5:7b)
    DATOS_AGENTE_URL        dirección del servidor; tiene que ser localhost (http://127.0.0.1:11434/v1, la de Ollama)
    DATOS_AGENTE_TIMEOUT    segundos de espera por respuesta (180)

Solo escribe propuestas. La decisión sobre cada hallazgo sigue siendo de una persona.
Sale con código 1 si el servidor del modelo falló, para que el cron lo marque.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import psycopg

from servicio_datos.agente import analista, autoprueba
from servicio_datos.agente.modelo import ErrorModelo, modelo_desde_entorno
from servicio_datos.ipc import fuente

LIMITE_POR_DEFECTO = 1500.0  # segundos de trabajo; el cron le da más tiempo a la tarea para que termine con gracia


def resumen(resultado: analista.ResultadoAnalisis) -> dict:
    return {"candidato": resultado.candidato_id, "por_modelo": resultado.por_modelo, "por_precedente": resultado.por_precedente,
            "sin_respaldo": resultado.sin_respaldo, "omitidos": resultado.omitidos, "sin_modelo": resultado.sin_modelo,
            "sin_tiempo": resultado.sin_tiempo, "fallidos": resultado.fallidos, "abortado": resultado.abortado}


def _probar(modelo) -> int:
    try:
        resultados = autoprueba.correr(modelo)
    except ErrorModelo as error:
        print(f"El modelo no responde: {error}", file=sys.stderr)
        return 1
    for r in resultados:
        notas = [r.error] if r.error else [f"dijo «{r.obtenido}»"] if not r.acierta else []
        if r.corregido:
            notas.append("con correcciones del validador")
        print(f"{'ok  ' if r.acierta else 'MAL '} {r.nombre} ({r.segundos:.1f} s)" + (f": {', '.join(notas)}" if notas else ""))
        if not r.acierta:
            print(f"     esperado: «{r.esperado}»")
    aciertos = sum(r.acierta for r in resultados)
    print(f"\n{modelo.nombre}: {aciertos} de {len(resultados)} casos bien clasificados; el validador corrigió {sum(r.corregido for r in resultados)}; "
          f"tardó {sum(r.segundos for r in resultados) / len(resultados):.1f} s por caso.")
    if aciertos < len(resultados) - 1:
        print("Con menos aciertos que esos, las propuestas van a ser ruido: probá con un modelo más grande.")
    return 0


def _estado(conn) -> int:
    filas = conn.execute(
        "SELECT origen, count(*), count(*) FILTER (WHERE estado = 'pendiente'), "
        "count(*) FILTER (WHERE estado <> 'pendiente' AND accion_sugerida IN ('aceptar', 'rechazar')), "
        "count(*) FILTER (WHERE estado = 'aprobada' AND accion_sugerida IN ('aceptar', 'rechazar')), "
        "count(*) FILTER (WHERE notas <> '[]'::jsonb) "
        "FROM propuesta WHERE accion_sugerida IS NOT NULL GROUP BY origen ORDER BY origen").fetchall()
    if not filas:
        print("Todavía no hay propuestas del analista.")
        return 0
    for origen, total, pendientes, comparables, coinciden, corregidas in filas:
        linea = f"{origen}: {total} propuestas, {pendientes} sin decidir"
        if comparables:
            linea += f"; de {comparables} que sugerían aceptar o rechazar y ya decidió una persona, coincidió en {coinciden} ({100 * coinciden // comparables}%)"
        if origen == "agente" and total:
            linea += f"; el validador corrigió {corregidas} de {total}"
        print(linea)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analista de hallazgos con un modelo local.")
    parser.add_argument("comando", nargs="?", choices=["analizar", "probar", "estado"], default="analizar")
    parser.add_argument("--url", default=os.environ.get("DATOS_DATABASE_URL"), help="URL de PostgreSQL (DATOS_DATABASE_URL)")
    parser.add_argument("--fuente", default=fuente.FUENTE_ID, help=f"Fuente a analizar (por defecto {fuente.FUENTE_ID})")
    parser.add_argument("--limite", type=float, default=LIMITE_POR_DEFECTO, help="Segundos de trabajo antes de dejar el resto para la próxima corrida")
    args = parser.parse_args(argv)

    if args.comando == "estado":
        if not args.url:
            parser.error("Falta la URL: usá --url o la variable DATOS_DATABASE_URL")
        with psycopg.connect(args.url, autocommit=True) as conn:
            return _estado(conn)

    try:
        modelo = modelo_desde_entorno(os.environ)
    except ValueError as error:
        print(f"Error de configuración: {error}", file=sys.stderr)
        return 1
    if args.comando == "probar":
        if modelo is None:
            print("No hay modelo configurado: definí DATOS_AGENTE_MODELO.", file=sys.stderr)
            return 1
        return _probar(modelo)

    if not args.url:
        parser.error("Falta la URL: usá --url o la variable DATOS_DATABASE_URL")
    if modelo is None:
        print("No hay modelo configurado (DATOS_AGENTE_MODELO): solo se repiten decisiones previas de las personas.", file=sys.stderr)
    with psycopg.connect(args.url, autocommit=True) as conn:
        resultados = analista.analizar_abiertos(conn, args.fuente, modelo, limite_segundos=args.limite)
    print(json.dumps({"modelo": modelo.nombre if modelo else None, "candidatos": [resumen(r) for r in resultados]}, ensure_ascii=False))
    return 1 if any(r.fallidos for r in resultados) else 0


if __name__ == "__main__":
    sys.exit(main())
