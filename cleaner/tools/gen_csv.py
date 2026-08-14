#!/usr/bin/env python3
"""Genera un CSV grande y deliberadamente sucio para medir el cleaner.

    python3 tools/gen_csv.py salida.csv 2000000

Mezcla lo que aparece en archivos reales: separador punto y coma, decimales con
coma, miles con punto, moneda, porcentajes, negativos entre parentesis, fechas
DD/MM/AAAA, marcadores de faltante variados, filas duplicadas, filas vacias,
campos entrecomillados con comas adentro y una columna constante.
"""
import random
import sys

PAISES = ["Argentina", "Brasil", "Chile", "Uruguay", "Paraguay", "Bolivia"]
FALTANTES = ["", "NA", "n/d", "-", "s/d", "#N/A"]
NOTAS = [
    "sin observaciones",
    '"revisar, urgente"',
    "dato provisorio",
    '"con ""comillas"" adentro"',
    "ok",
]


def miles(n: int) -> str:
    """1234567 -> 1.234.567"""
    s = f"{n:,}"
    return s.replace(",", ".")


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    path, rows = sys.argv[1], int(sys.argv[2])
    rng = random.Random(20240814)

    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write("﻿fecha;pais;pbi;inflacion;deuda;constante;nota\r\n")
        previa = None
        for i in range(rows):
            if rng.random() < 0.002:
                f.write("\r\n")  # fila vacia
                continue
            if previa is not None and rng.random() < 0.01:
                f.write(previa)  # fila duplicada
                continue

            dia = rng.randint(1, 28)
            mes = rng.randint(1, 12)
            anio = 2015 + (i % 10)
            pais = rng.choice(PAISES)

            if rng.random() < 0.03:
                pbi = rng.choice(FALTANTES)
            else:
                pbi = f"{rng.randint(100, 999)}.{rng.randint(0, 999):03d},{rng.randint(0, 99):02d}"

            if rng.random() < 0.02:
                infl = rng.choice(FALTANTES)
            else:
                infl = f"{rng.randint(0, 300)},{rng.randint(0, 9)}%"

            monto = rng.randint(1000, 9999999)
            deuda = f"($ {miles(monto)})" if rng.random() < 0.05 else f"$ {miles(monto)}"

            nota = rng.choice(NOTAS)
            linea = f"{dia:02d}/{mes:02d}/{anio};{pais};{pbi};{infl};{deuda};7;{nota}\r\n"
            f.write(linea)
            previa = linea
    return 0


if __name__ == "__main__":
    sys.exit(main())
