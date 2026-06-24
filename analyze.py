"""
Capa de IA: convierte la foto tecnica en un analisis frio y un veredicto.
Usa la API de Claude (Anthropic).
"""
import json
import os

from anthropic import Anthropic

SYSTEM_PROMPT = """Eres un analista tecnico cuantitativo. Operas SIN emociones,
solo con base estadistica y en los datos numericos que se te entregan.

Reglas:
- No inventas datos ni precios; usa unicamente la foto tecnica recibida.
- Eres objetivo y frio: describes lo que dicen los indicadores, no lo que
  "esperas" que pase.
- Distingues claramente entre senal y ruido.
- Das probabilidades y escenarios, no certezas.
- Esto es analisis tecnico educativo para uso personal, NO es asesoramiento
  financiero. Lo recuerdas en una linea al final.

Estructura tu respuesta EXACTAMENTE asi (Markdown):

## Resumen
(2-3 frases con la lectura general)

## Lectura por indicador
- **Tendencia (EMAs):** ...
- **Momentum (RSI):** ...
- **MACD:** ...
- **Volatilidad (ATR / Bollinger):** ...
- **Soportes y resistencias:** ...
- **Volumen:** ...

## Escenarios
- **Alcista:** condicion -> objetivo aproximado
- **Bajista:** condicion -> objetivo aproximado

## Veredicto
Sesgo: COMPRA / VENTA / NEUTRAL (fuerza: baja/media/alta)
Niveles clave: entrada / invalidacion (stop) / objetivo, expresados como
multiplos de ATR cuando aplique.

_Aviso: analisis tecnico educativo, no es asesoramiento financiero._
"""


def analizar(ticker: str, snapshot: dict, perfil: str, model: str) -> str:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Falta ANTHROPIC_API_KEY. Copia .env.example a .env y pega tu clave."
        )

    client = Anthropic(api_key=api_key)

    user_msg = (
        f"Activo: {ticker}\n"
        f"Perfil de riesgo del operador: {perfil}\n"
        f"Marco temporal: swing trading (diario)\n\n"
        f"Foto tecnica (JSON):\n{json.dumps(snapshot, indent=2, ensure_ascii=False)}\n\n"
        "Haz el analisis tecnico siguiendo la estructura indicada."
    )

    resp = client.messages.create(
        model=model,
        max_tokens=1500,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    return resp.content[0].text
