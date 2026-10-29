import {capture,validatePoints,type Job} from './capture.ts';
function assert(ok:unknown,message='Falló el contrato'):asserts ok{if(!ok)throw new Error(message);}
async function rejects(work:()=>unknown){let fail=false;try{await work();}catch{fail=true;}assert(fail,'Debía rechazar la captura');}
const job:Job={id:'x',upstream_id:'serie',token:'x',kind:'datos_csv',column:'valor',url:'https://infra.datos.gob.ar/catalog/sspm/prueba.csv',frequency:'Anual',unit:'u',name:'Prueba',start:'2024-01-01',license:'CC BY 4.0'};
Deno.test('CSV preserva decimales, cero y frecuencia anual',async()=>{
 const metadata={meta:[{catalog:{identifier:'sspm',license:'CC BY 4.0'},distribution:{downloadURL:job.url},field:{id:'serie',title:'valor',description:'Prueba',units:'u',frequency:'R/P1Y'}}]};
 const get=((url:string)=>Promise.resolve(new Response(url.includes('metadata=only')?JSON.stringify(metadata):'indice_tiempo,valor\n2024-01-01,1.000000000000000001\n2025-01-01,0\n'))) as typeof fetch;
 const result=await capture(job,get,'2026-10-29');assert(result.points[0][1]==='1.000000000000000001');assert(result.points[1][1]==='0');
 metadata.meta[0].field.units='otra';await rejects(()=>capture(job,get,'2026-10-29'));
});
Deno.test('BCRA pagina íntegramente y conserva el token decimal original',async()=>{
 const bcra={...job,kind:'bcra_v4',column:'1',url:'https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/1',frequency:'Diaria',upstream_id:'bcra_v4_1'} as Job;
 const urls:string[]=[];
 const get=((url:string)=>{urls.push(url);return Promise.resolve(new Response(url.includes('?idVariable=')?JSON.stringify({status:200,results:[{idVariable:1,descripcion:'Prueba',periodicidad:'D',unidadExpresion:'u'}]}):`{"status":200,"metadata":{"resultset":{"count":2}},"results":[{"idVariable":1,"detalle":[{"fecha":"${url.includes('offset=0')?'2026-10-28':'2026-10-27'}","valor":1.000000000000000001}]}]}`));}) as typeof fetch;
 const result=await capture(bcra,get,'2026-10-29');assert(urls.length===3);assert(result.points[0][0]==='2026-10-27');assert(result.points[1][1]==='1.000000000000000001');
});
Deno.test('rechaza futuros, duplicados y fechas incompatibles sin completar huecos',async()=>{
 await rejects(()=>validatePoints([['2027-01-01','1']],'Anual','2026-10-29'));
 await rejects(()=>validatePoints([['2026-10-01','1'],['2026-10-01','2']],'Mensual','2026-10-29'));
 await rejects(()=>validatePoints([['2026-02-30','1']],'Diaria','2026-10-29'));
 await rejects(()=>validatePoints([['2026-10-02','1']],'Mensual','2026-10-29'));
 validatePoints([['2026-10-23','0'],['2026-10-26','1']],'Diaria','2026-10-29');
});
