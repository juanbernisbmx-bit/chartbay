# ChartBay 1.0 — Checklist de QA

Complemento de [`V1_RELEASE_SCOPE.md`](V1_RELEASE_SCOPE.md), que define **qué**
entra en 1.0. Este documento dice **cómo se comprueba**.

Está separado en tres bloques por una razón práctica: el primero lo corre una
máquina, el segundo lo tiene que mirar una persona, y el tercero solo se puede
hacer contra el sitio ya desplegado. Confundirlos es el error que este proyecto
ya cometió una vez —17 plantillas devolvían 200, los IDs estaban intactos, y
aun así había seis errores visibles a simple vista.

> **"Renderiza 200" y "no perdí IDs" no dicen nada sobre si la página se lee.**

---

## Bloque A — Automático

Todo esto lo verifica CI. Si algo de acá falla, no hay nada que discutir.

```bash
# Motor econométrico
PATH="$PWD/.venv/bin:$PATH" npm --prefix quantbay run test

# Proveedores de datos macro, sin red
python tests/test_providers.py

# App Flask: rutas, secciones, headers, CSP, CSRF, flags
python tests/test_web.py

# Limpiador C++ nativo y su build WebAssembly
make -C cleaner test
make -C cleaner wasm-test
```

- [ ] Vitest: 1510/1510 en 86 archivos
- [ ] Providers: 13/13
- [ ] Flask: 49/49
- [ ] Cleaner nativo y WASM
- [ ] `npx tsc --noEmit` sin errores
- [ ] `npm run build` no deja el bundle desactualizado (`git diff --exit-code -- web/static/js`)

> Los 18 tests de `statsmodelsValidation.test.ts` levantan un intérprete de
> Python real. Sin NumPy, SciPy y statsmodels fallan con `spawnSync python
> ENOENT` — eso es un fallo **de entorno**, no del código. Se resuelve con
> `requirements-dev.txt` y el `PATH` del venv.

---

## Bloque B — Revisión visual

**Este bloque no es opcional aunque todo el bloque A esté en verde.** En un
re-skin sobre CSS heredado, los errores son de color, contraste y ancho de caja,
y ningún assert sobre el HTML los ve.

Levantar el sitio y **mirar** las cinco páginas activas:

```bash
SECRET_KEY=dev APP_ENV=development python web/app.py
```

### B.1 — Las cinco páginas

Para cada una de `/`, `/econometria`, `/limpiador`, `/data` y `/guia`:

- [ ] La página se lee: sin texto ilegible por contraste ni cajas de un carácter de ancho
- [ ] Sin fondo oscuro asomando al scrollear
- [ ] La consola del navegador no tiene **ningún** error
- [ ] Las fuentes IBM Plex cargan de verdad (no la fuente del sistema)
- [ ] Ancho de contenido razonable: la página no se estira de borde a borde
- [ ] A 375 px de ancho el contenido no desborda en horizontal

Dos barridos que encuentran lo que la captura no delata. Pegar en la consola:

```js
// 1. Elementos con fondo oscuro donde no corresponde
[...document.querySelectorAll('*')].filter(el => {
  const bg = getComputedStyle(el).backgroundColor;
  const m = bg.match(/\d+/g);
  return m && m[3] !== '0' && (+m[0] + +m[1] + +m[2]) / 3 < 60;
}).map(el => el.tagName + '.' + el.className);
```

```js
// 2. Contraste texto/fondo por debajo de 3:1
const rgba = s => { const n = s.match(/[\d.]+/g)?.map(Number) || [];
  return [n[0] || 0, n[1] || 0, n[2] || 0, n.length > 3 ? n[3] : 1]; };
const over = (fg, bg) => { const a = fg[3] + bg[3] * (1 - fg[3]);
  return [...[0,1,2].map(i => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / a), a]; };
const bgOf = el => { const chain = []; for (let n = el; n; n = n.parentElement) chain.push(n);
  return chain.reverse().reduce((bg, n) => over(rgba(getComputedStyle(n).backgroundColor), bg), [255,255,255,1]); };
const lum = c => { const s = c.slice(0, 3).map(v => { v /= 255;
  return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * s[0] + .7152 * s[1] + .0722 * s[2]; };
[...document.querySelectorAll('p,span,a,td,th,li,strong,h1,h2,h3,h4,label,button')]
  .filter(el => el.textContent.trim() && el.offsetParent)
  .map(el => { const bg = bgOf(el), text = over(rgba(getComputedStyle(el).color), bg);
    const L1 = lum(text), L2 = lum(bg);
    const r = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
    return { el: el.tagName + '.' + el.className, ratio: +r.toFixed(2) }; })
  .filter(x => x.ratio < 3);
```

- [ ] El barrido de fondos oscuros no devuelve nada inesperado
- [ ] El barrido de contraste no devuelve nada por debajo de 3:1

### B.2 — Lo que 1.0 promete

- [ ] La barra superior muestra Inicio, Econometría, Datos, Limpiador y Documentación
- [ ] **No** aparece "Entrar" en ninguna página
- [ ] **No** aparecen Agro ni Finanzas Quant en el menú
- [ ] `/agro`, `/chartbay`, `/community`, `/login` devuelven 404
- [ ] En `/guia`, el recuadro de alcance está arriba y se lee
- [ ] En `/`, la tabla de módulos dice "Ecuaciones normales", **no** "Descomposición QR"

### B.3 — Pro tiene que verse como beta

En `/econometria`, panel **Versión** de la barra izquierda:

- [ ] El selector dice "Pro — Python (Pyodide) · beta"
- [ ] Al elegir Pro, **Estado** dice **Beta** (no "Disponible")
- [ ] Aparece el recuadro ámbar de aviso y se lee
- [ ] Límite CSV cambia a 10 MB
- [ ] Al volver a Lite, Estado vuelve a "Disponible", el aviso se oculta y el límite vuelve a 100 MB

> Si el Estado dice "Disponible" con Pro elegida, el bundle quedó desactualizado
> respecto de `chartbayVersions.ts` o `versionView.ts`: reconstruirlo y repetir
> los tests de navegación y versión.

### B.4 — Dependencias del laboratorio

En `/econometria`, consola:

```js
({ papa: typeof Papa, chart: Chart.version, jspdf: typeof jspdf })
```

- [ ] `Papa` es `object`, `Chart.version` es **exactamente `4.5.1`**, `jspdf` es `object`
- [ ] No hay requests a jsDelivr ni cdnjs al usar Lite
- [ ] Al bloquear jsDelivr, Pro falla con un mensaje visible y Lite sigue disponible

> Estas librerías viajan en `quantbay.bundle.js`; sus versiones exactas están en
> `quantbay/package-lock.json`. Pyodide es la única descarga bajo demanda y se
> ejecuta dentro de `quantbay.pro.worker.js`.

### B.5 — Un análisis de punta a punta (Lite)

- [ ] Cargar `datasets/01_simple_linear.csv` desde el laboratorio
- [ ] Elegir Y y una X, estimar: salen coeficientes, errores estándar, t, p y R²
- [ ] Los diagnósticos se pueblan
- [ ] `05_perfect_collinearity.csv` da un error claro, no una pantalla rota
- [ ] Exportar a PDF y a CSV produce archivos abribles
- [ ] El código reproducible se genera para R, Python, Stata y notebook

### B.6 — Limpiador y Datos

- [ ] `/limpiador` acepta un CSV y muestra el informe de limpieza
- [ ] El worker WebAssembly arranca (sin caída silenciosa al lector clásico)
- [ ] `/data` lista los 49 indicadores
- [ ] Sin `FRED_API_KEY`: se ve el aviso y las descargas de World Bank funcionan igual
- [ ] Con `FRED_API_KEY`: una serie FRED descarga en CSV y en JSON
- [ ] CSV y JSON conservan `source`, `series_id` y `terms_url`

---

## Bloque C — Después de desplegar

Contra la URL real. Nada de esto se puede comprobar en local.

- [ ] El Blueprint arranca **sin** `APP_USERNAME`, `APP_PASSWORD` ni `ANTHROPIC_API_KEY`
- [ ] El health check de Render queda verde (apunta a `/version`)
- [ ] `curl -s https://chartbay.onrender.com/version` devuelve el commit esperado
- [ ] Cargar `FRED_API_KEY` en el panel y confirmar que las 37 series FRED se habilitan
- [ ] Las cabeceras de seguridad viajan en producción:

```bash
curl -sI https://chartbay.onrender.com/econometria | grep -i \
  'content-security-policy\|x-content-type\|x-frame\|referrer'
```

- [ ] El CSP de `/econometria` incluye `wasm-unsafe-eval` y no abre CDNs
- [ ] El CSP de `/static/js/quantbay.pro.worker.js` abre sólo `cdn.jsdelivr.net`
- [ ] El CSP de `/` **no** los incluye
- [ ] Ningún CSP menciona `tradingview`
- [ ] Las fuentes cargan sobre HTTPS real (no solo en local)

---

## Estado del QA de Pyodide

La paridad numérica y la carga principal están verificadas, pero faltan entornos
reales. Pro permanece beta hasta completar esa cobertura. El cálculo fue movido
a un worker dedicado para que el hilo de la interfaz siga respondiendo.

Resultados ya obtenidos:

- [x] Nueve escenarios contra statsmodels 0.14.6 de escritorio, exactos a seis
  decimales: OLS simple y múltiple, dummies, HC1, HC3, HAC, tres RLS y faltantes
  con listwise (`n=143`).
- [x] Lite y Pro coinciden con diferencias del orden de `1e-14`.
- [x] 363.493 filas / 9,5 MiB procesadas en la implementación original. El
  cálculo ahora está aislado en un worker y se cancela a los 120 s. El límite
  de Pro se mantiene en 10 MB y no debe subirse.
- [x] Pyodide arrancó en 21–35 s en una máquina rápida.
- [x] Más de 10 MB muestra un error claro; una caída de jsDelivr falla con
  mensaje después de 16 s; seis alternancias Lite⇄Pro fueron estables.

Lo que todavía hace falta medir:

- [ ] Tiempo de arranque de Pyodide en un equipo modesto y en una conexión lenta
- [ ] Memoria máxima en un equipo modesto con el CSV grande
- [ ] **Safari** en escritorio (Chrome y Firefox ya se cubrieron en el entorno disponible)
- [ ] Al menos un navegador móvil
- [ ] Repetir el caso grande y confirmar que la UI recibe eventos mientras corre
- [ ] ACF, PACF, Ljung-Box y un ARIMA manual con forecast en navegador real

Con eso medido se puede decidir si Pro deja de ser beta. La evidencia actual no
justifica subir el tope de 10 MB.

---

## Antes de tocar el laboratorio

`web/static/js/quantbay.bundle.js` busca por `id` unos 190 elementos de
`quantbay.html`. Si un rediseño pierde IDs, **el JavaScript no falla**: deja de
encontrar sus nodos y los paneles quedan vacíos, en silencio.

```bash
diff <(git show HEAD:web/templates/quantbay.html | grep -o 'id="[^"]*"' | sort) \
     <(grep -o 'id="[^"]*"' web/templates/quantbay.html | sort)
```

- [ ] No hay líneas `<` (IDs eliminados). Agregar está bien; sacar no.
