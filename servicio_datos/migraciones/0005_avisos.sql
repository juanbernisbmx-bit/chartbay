-- Avisos por Slack o correo cuando algo entra a "Requieren atención" o el sistema se queda callado.
--
-- Es una bandeja de salida: primero se registra el aviso y después se intenta entregarlo. Así un
-- Slack caído no pierde nada (se reintenta en la corrida siguiente) y un aviso nunca se repite:
-- `clave` es única y dice de qué se avisa (p. ej. `candidato_nuevo:3`, `corrida_fallida:12`).
--
-- Guarda el texto sin el enlace: la dirección de la interfaz es configuración, no historia.

CREATE TABLE aviso (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clave       text NOT NULL UNIQUE,
  tipo        text NOT NULL CHECK (tipo IN ('candidato_nuevo', 'corrida_fallida', 'sin_datos', 'colector_inactivo')),
  fuente_id   text REFERENCES fuente(id),
  referencia  text NOT NULL,
  asunto      text NOT NULL,
  cuerpo      text NOT NULL,
  ruta        text,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  -- pendiente: falta entregarlo; enviado: llegó por todos los canales; descartado: dejó de ser cierto
  -- antes de entregarse; fallido: se agotaron los intentos.
  estado      text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'enviado', 'descartado', 'fallido')),
  intentos    integer NOT NULL DEFAULT 0,
  entregas    jsonb NOT NULL DEFAULT '{}'::jsonb,
  enviado_en  timestamptz
);
CREATE INDEX aviso_pendientes ON aviso (id) WHERE estado = 'pendiente';
