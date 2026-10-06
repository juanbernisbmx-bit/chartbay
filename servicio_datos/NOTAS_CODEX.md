# Entrega Codex: parser y validación del IPC

Rama `codex/ipc-parser`, worktree `/private/tmp/chartbay-ipc-parser`, base
`4cacfa0` de `claude/base-datos-postgres`. Archivos propios:
`ipc/parser.py`, `ipc/validacion.py`, `tests/test_parser.py`,
`tests/test_validacion.py` y la línea `xlrd==2.0.2` de `requirements.txt`.

## Contrato listo para el orquestador

- `leer_archivo(descarga.ruta, archivo_configurado)` devuelve
  `dict[str, SerieLeida]` o lanza `ErrorParseo`. Las fechas se normalizan al
  primer día del mes con nota, y los valores son `Decimal(str(float))`.
- `validar(series, vigentes, descargas, *, hoy=None)` devuelve `list[Hallazgo]`.
  El argumento `hoy` es opcional y sirve para fijar el reloj en pruebas. No
  modifica datos ni publica candidatos.
- `descargas` debe incluir los dos archivos de la corrida, nuevos o idénticos;
  la regla de frescura solo corre para archivos presentes ahí.
- Reglas: `estructura`, `base_referencia`, `continuidad`, `rango`,
  `salto_mensual`, `fecha_normalizada`, `historia_intacta`, `cobertura`,
  `cruce_regional`, `frescura`.

## Decisiones provisionales

`SALTO_MENSUAL_ALERTA_PCT = 20` y `DIA_LIMITE_PUBLICACION = 25` están al inicio
de `ipc/validacion.py`. Son umbrales para **alertar**, no para rechazar ni
modificar un valor; Juani puede cambiarlos tras revisar el historial y el
calendario oficial. Al 2026-10-06 los XLS vigentes producen 12 alertas de salto
histórico y 7 notas de encabezado normalizado, ninguna de cobertura o frescura.
Con el nacional viejo `08_26`, la cobertura y la frescura sí alertan.

## Comprobación

Los tests sintéticos de parser y validación no necesitan los XLS de INDEC. Con
`DATOS_IPC_ORIGINALES_DIR` se agrega la prueba contra `09_26` y aperturas.
Comparé los resultados contra `scripts/preparar_piloto.py`: coinciden los 819
valores de las siete series del piloto actualizado.

En el checkout compartido corregí mi test `test_piloto_chartbay.py` para que
se saltee cuando el JSON local no exista, como pediste. No toqué archivos de
Claude ni hice push.
