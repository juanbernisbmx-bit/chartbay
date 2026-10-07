// Imprime la carga que arma la colecta con los archivos de una carpeta: la usa una prueba de Python para comparar el parser de
// TypeScript con el de Python. Uso: deno run --allow-read --allow-import=cdn.sheetjs.com imprimir_carga.ts <carpeta> <nacional.xls> <hoy>
import { cargaDe } from "./carga.ts";
import { archivos } from "./fuente_ipc.ts";
import { leerArchivo } from "./parser_ipc.ts";

const [carpeta, nacional, hoy] = Deno.args;
const series = {};
for (const archivo of archivos(hoy)) {
  const nombre = archivo.clave === "nacional" ? nacional : "sh_ipc_aperturas.xls";
  Object.assign(series, leerArchivo(Deno.readFileSync(`${carpeta}/${nombre}`), nombre, archivo));
}
console.log(JSON.stringify(cargaDe(series, ["nacional", "aperturas"])));
