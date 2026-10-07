import { assertEquals } from "jsr:@std/assert@1";
import { comoPython } from "./numeros.ts";
import { isoUtc } from "./fechas.ts";

Deno.test("los números se escriben como en Python", () => {
  assertEquals([100, 101.5859, 0.5, 105.10000000000001, 7255.6745, -3, NaN].map(comoPython), ["100.0", "101.5859", "0.5", "105.10000000000001", "7255.6745", "-3.0", "NaN"]);
});

Deno.test("las fechas en UTC como las escribe Python", () => {
  assertEquals(isoUtc(new Date("2026-09-10T18:52:05Z")), "2026-09-10T18:52:05+00:00");
  assertEquals(isoUtc(new Date("2026-09-10T18:52:05.123Z")), "2026-09-10T18:52:05.123000+00:00");
});
