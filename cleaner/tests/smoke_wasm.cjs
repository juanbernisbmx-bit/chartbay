/**
 * Smoke test for the compiled WASM module.
 *
 * Compiling proves nothing on its own. This drives the real artifact through
 * the same C ABI the browser wrapper uses, and demands that its report come
 * back byte-for-byte identical to the native binary's — the one covered by the
 * 355 checks in `make test`. If a flag, a type width or the exception setting
 * changed behaviour on the way to WebAssembly, the two stop matching here.
 *
 *   node tests/smoke_wasm.cjs <module.js> <fixture.csv> <native-report.json>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const [, , modulePath, csvPath, nativeReportPath] = process.argv;
if (!modulePath || !csvPath || !nativeReportPath) {
  console.error('uso: node smoke_wasm.cjs <module.js> <fixture.csv> <native-report.json>');
  process.exit(2);
}

// Mirrors the Ints/Reals enums in wasm/bindings.cpp and js/csvclean.ts.
const INT_SLOTS = 16;
const REAL_SLOTS = 5;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  const mark = ok ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark} ${label}${ok ? '' : `\n         got ${actual}, want ${expected}`}`);
}

function checkTrue(label, cond) {
  check(label, Boolean(cond), true);
}

async function main() {
  const factory = require(path.resolve(modulePath));
  const wasm = await factory();
  const csv = fs.readFileSync(csvPath);

  console.log(`\n\x1b[1mwasm\x1b[0m  ${path.basename(modulePath)}  ${csv.length} bytes de entrada`);

  const intsPtr = wasm._cbc_alloc(INT_SLOTS * 4);
  const realsPtr = wasm._cbc_alloc(REAL_SLOTS * 8);
  const ints = new Int32Array(INT_SLOTS);
  const reals = new Float64Array(REAL_SLOTS);

  // Defaults identical to the CLI's, so the two reports are comparable.
  ints[0] = 1;                       // sniff
  ints[2] = 1;                       // has header
  ints[3] = '.'.charCodeAt(0);       // fallback decimal
  ints[4] = 2;                       // fallback date order: dmy
  ints[8] = ints[9] = ints[10] = ints[11] = ints[12] = 1;  // the drop flags
  reals[0] = 0.8;                    // numeric threshold
  reals[1] = 0.9;                    // date threshold
  reals[2] = 0.2;                    // categorical ratio
  reals[3] = 3;                      // outlier k
  reals[4] = csv.length;             // total bytes hint
  wasm.HEAP32.set(ints, intsPtr >> 2);
  wasm.HEAPF64.set(reals, realsPtr >> 3);

  const handle = wasm._cbc_create(intsPtr, INT_SLOTS, realsPtr, REAL_SLOTS);
  checkTrue('cbc_create devuelve un handle', handle !== 0);

  // Deliberately tiny chunks: this is the path that splits quoted fields and
  // CRLF pairs across calls, which is where a streaming parser breaks.
  const CHUNK = 7;
  const buffer = wasm._cbc_alloc(CHUNK);
  for (let offset = 0; offset < csv.length; offset += CHUNK) {
    const slice = csv.subarray(offset, Math.min(offset + CHUNK, csv.length));
    wasm.HEAPU8.set(slice, buffer);
    const code = wasm._cbc_feed(handle, buffer, slice.length);
    if (code !== 0) {
      check(`cbc_feed en el offset ${offset}`, code, 0);
      break;
    }
  }
  wasm._cbc_free(buffer);
  check('cbc_finish', wasm._cbc_finish(handle), 0);

  const report = JSON.parse(wasm.UTF8ToString(wasm._cbc_report_json(handle)));
  const native = JSON.parse(fs.readFileSync(nativeReportPath, 'utf8'));

  console.log(
    `      ${report.rowsIn} filas leídas → ${report.rowsOut} filas, ` +
      `${report.columnsOut} columnas, separador "${report.dialect.delimiter}"`
  );

  check(
    'el reporte coincide con el del binario nativo',
    JSON.stringify(report),
    JSON.stringify(native)
  );

  // Read the columns back the way the browser wrapper does, to prove the
  // pointers and typed-array views are wired correctly and not just that the
  // JSON serialiser works.
  const rows = wasm._cbc_row_count(handle);
  const count = wasm._cbc_column_count(handle);
  check('cbc_row_count coincide con el reporte', rows, report.rowsOut);
  check('cbc_column_count coincide con el reporte', count, report.columnsOut);

  for (let j = 0; j < count; j++) {
    const name = wasm.UTF8ToString(wasm._cbc_column_name(handle, j));
    const type = wasm._cbc_column_type(handle, j);
    const info = report.columns[j];
    check(`columna ${j} se llama igual que en el reporte`, name, info.name);

    const maskPtr = wasm._cbc_column_mask(handle, j);
    const mask = wasm.HEAPU8.subarray(maskPtr, maskPtr + rows);
    let present = 0;
    for (let i = 0; i < rows; i++) present += mask[i];
    check(`"${name}" tiene los presentes que dice el reporte`, present, info.present);

    if (type === 1 || type === 2) {
      const ptr = wasm._cbc_column_values(handle, j);
      const values = wasm.HEAPF64.subarray(ptr >> 3, (ptr >> 3) + rows);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < rows; i++) {
        if (!mask[i]) continue;
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
      }
      if (info.min !== undefined) {
        check(`"${name}" min coincide`, min, info.min);
        check(`"${name}" max coincide`, max, info.max);
      }
    } else if (type === 3) {
      const levels = wasm._cbc_level_count(handle, j);
      check(`"${name}" tiene los niveles que dice el reporte`, levels, info.unique);
    }
  }

  wasm._cbc_destroy(handle);
  wasm._cbc_free(intsPtr);
  wasm._cbc_free(realsPtr);

  console.log(
    failures === 0
      ? '\n\x1b[32mel wasm y el binario nativo coinciden\x1b[0m\n'
      : `\n\x1b[31m${failures} diferencias\x1b[0m\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
