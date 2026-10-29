import Papa from 'npm:papaparse@5.4.1';
import { parseExact } from '../colectar-series/api.ts';
export interface Job { id:string;upstream_id:string;token:string;kind:'datos_csv'|'bcra_v4';column:string;url:string;frequency:'Diaria'|'Mensual'|'Anual';unit:string;name:string;start:string;license:string }
export interface Capture {points:string[][];raw:Uint8Array;url:string}
const numberPattern=/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
function exact<T>(text:string):T{return parseExact(text) as unknown as T;}
async function text(url:string,get:typeof fetch,limit:number):Promise<string>{
 const response=await get(url,{signal:AbortSignal.timeout(8000),redirect:'error'});
 if(!response.ok)throw new Error(`Fuente oficial HTTP ${response.status}`);
 const reader=response.body?.getReader();if(!reader)throw new Error('Respuesta vacía');
 const chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit)throw new Error('Respuesta demasiado grande');chunks.push(value);}}
 finally{await reader.cancel();}
 const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
 return new TextDecoder('utf-8',{fatal:true}).decode(raw);
}
export function validatePoints(points:string[][],frequency:Job['frequency'],today:string):void{
 if(!points.length||points.length>12000)throw new Error('Cantidad de observaciones inválida');
 let previous='';
 for(const row of points){
  const day=row[0];if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day||day<=previous||day>today)throw new Error('Fecha inválida, duplicada o futura');
  if(frequency==='Mensual'&&!day.endsWith('-01')||frequency==='Anual'&&!day.endsWith('-01-01'))throw new Error('Frecuencia incompatible');
  if(typeof row[1]!=='string'||!numberPattern.test(row[1]))throw new Error('Número inválido');previous=day;
 }
}
export async function capture(job:Job,get:typeof fetch=fetch,today=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Argentina/Buenos_Aires'}).format(new Date())):Promise<Capture>{
 const pages:Array<{url:string;body:string}>=[];let points:string[][]=[];
 if(job.kind==='datos_csv'){
  if(!/^https:\/\/infra\.datos\.gob\.ar\/catalog\/sspm\/[^?#]+\.csv$/.test(job.url)||!/^[A-Za-z0-9_.-]+$/.test(job.upstream_id))throw new Error('Recurso fuera de catálogo');
  const url='https://apis.datos.gob.ar/series/api/series/?'+new URLSearchParams({ids:job.upstream_id,metadata:'only',format:'json'});
  const body=await text(url,get,2000000);pages.push({url,body});
  const metadata=exact<{meta:Array<{catalog?:{identifier:string;license?:string};dataset?:{license?:string};distribution?:{downloadURL:string};field?:{id:string;title:string;description:string;units:string;frequency:string}}>}>(body);
  const m=metadata.meta?.find(m=>m.field?.id===job.upstream_id);const code={Diaria:'R/P1D',Mensual:'R/P1M',Anual:'R/P1Y'}[job.frequency];
  if(!m||m.catalog?.identifier!=='sspm'||m.distribution?.downloadURL!==job.url||m.field?.title!==job.column||m.field.description?.trim()!==job.name||m.field.units!==job.unit||m.field.frequency!==code||(m.dataset?.license||m.catalog.license)!==job.license)throw new Error('La definición o licencia cambió');
  const csv=await text(job.url,get,8000000);pages.push({url:job.url,body:csv});
  const parsed=Papa.parse(csv,{skipEmptyLines:'greedy'}) as {data:string[][];errors:unknown[]};
  if(parsed.errors.length||parsed.data.length>20000)throw new Error('CSV incompatible');
  const headers=parsed.data.shift()!;const index=headers.indexOf('indice_tiempo'),column=headers.indexOf(job.column);
  if(index<0||column<0||headers.filter(h=>h===job.column).length!==1)throw new Error('Columna ausente o ambigua');
  for(const row of parsed.data){const value=row[column]?.trim();if(value===undefined)throw new Error('Fila incompleta');if(['','na','n/a','nan','null'].includes(value.toLowerCase()))continue;points.push([row[index]?.trim(),value]);}
 }else if(job.kind==='bcra_v4'){
  if(!/^\d+$/.test(job.column)||job.url!=='https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/'+job.column||job.frequency!=='Diaria')throw new Error('Variable BCRA incompatible');
  const url='https://api.bcra.gob.ar/estadisticas/v4.0/monetarias?'+new URLSearchParams({idVariable:job.column,limit:'1000'});
  const body=await text(url,get,2000000);pages.push({url,body});
  const meta=exact<{status:string;results:Array<{idVariable:string;descripcion:string;periodicidad:string;unidadExpresion:string}>}>(body);
  const m=meta.results?.find(m=>String(m.idVariable)===job.column);
  if(Number(meta.status)!==200||!m||m.periodicidad!=='D'||m.unidadExpresion!==job.unit||m.descripcion.trim()!==job.name)throw new Error('La definición del BCRA cambió');
  let offset=0,total=-1;
  do{
   const url=job.url+'?'+new URLSearchParams({desde:job.start,hasta:today,limit:'1000',offset:String(offset)});
   const body=await text(url,get,1500000);pages.push({url,body});
   const payload=exact<{status:string;metadata:{resultset:{count:string}};results:Array<{idVariable:string;detalle:Array<{fecha:string;valor:string}>}>}>(body);
   const count=Number(payload.metadata?.resultset?.count),series=payload.results?.[0];
   if(Number(payload.status)!==200||!Number.isInteger(count)||count<1||count>12000||total>=0&&total!==count||payload.results.length!==1||String(series?.idVariable)!==job.column||!series.detalle.length||offset+series.detalle.length>count)throw new Error('Paginación BCRA incompleta');
   total=count;points.push(...series.detalle.map(p=>[p.fecha,p.valor]));offset+=series.detalle.length;
  }while(offset<total);
 }else throw new Error('Origen incompatible');
 points.sort((a,b)=>a[0].localeCompare(b[0]));validatePoints(points,job.frequency,today);
 const raw=new TextEncoder().encode(JSON.stringify({upstream_id:job.upstream_id,pages}));if(raw.length>16000000)throw new Error('Captura demasiado grande');
 return {points,raw,url:job.url};
}
