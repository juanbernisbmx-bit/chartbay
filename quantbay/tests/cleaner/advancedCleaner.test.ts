// @vitest-environment node
import 'fake-indexeddb/auto';
import {describe, it, expect, afterEach} from 'vitest';
import {CleanerSession} from '../../src/dataCleaner/session';
import {CleanerStorage, deleteStorage} from '../../src/dataCleaner/storage';
import {DEFAULT_RULES, type Rules, type Row} from '../../src/dataCleaner/model';
import {DEFAULT_OUTLIERS, type ValidationRule} from '../../src/dataCleaner/advancedTypes';
import {ruleFailure, validateRules} from '../../src/dataCleaner/validation';
import {exportSession, exportQuality, type TextSink} from '../../src/dataCleaner/exporter';
import {compareSessions, exportComparison, matchingKey} from '../../src/dataCleaner/comparison';
import {createRecipe, recipeRules, parseRecipe, saveRecipe, listRecipes, deleteRecipe} from '../../src/dataCleaner/recipes';
const sessions: CleanerSession[]=[];
async function create(csv:string, rules:Rules=DEFAULT_RULES):Promise<CleanerSession>{
  const s=new CleanerSession(await CleanerStorage.open('advanced-'+crypto.randomUUID()),()=>{},()=>{});sessions.push(s);
  await s.import(new File([csv],'datos.csv'),{});await s.review(rules);return s;
}
afterEach(async()=>{for(const s of sessions.splice(0)){const name=s.storage.db.name;s.storage.close();await deleteStorage(name);}});
function sink():TextSink & {text:string}{return{text:'',write:async function(value){this.text+=value;},close:async()=>{},abort:async()=>{}};}
const condition=(kind:ValidationRule['kind'],column:string,extra:Partial<ValidationRule>={}):ValidationRule=>({id:crypto.randomUUID(),label:kind,kind,column,severity:'advertencia',...extra});
describe('Exact advanced profiles and flags',()=>{
  it('computes exact median, interpolated quartiles, sample SD, null rate and full-file category frequencies',async()=>{
    const s=await create('valor,provincia\n1,Bs As\n2,Buenos Aires\n3,Bs As\n4,BUENOS AIRES\n100,Pcia. Bs. As.\nNA,Bs As');
    const [p,c]=s.candidate!.profiles;
    expect(p.advanced).toMatchObject({count:5,median:3,q1:2,q3:4,mean:22,nullPercent:100/6});
    expect(p.advanced!.sd).toBeCloseTo(43.6176569751);
    expect(c.unique).toBe(4);
    expect(c.advanced!.topCategories[0]).toEqual({value:'Bs As',count:3});
    expect(s.candidate!.categorySuggestions![0].variants).toHaveLength(4);
  });
  it.each(['iqr','zscore','percentile'] as const)('flags %s outliers without deleting or rewriting them',async method=>{
    const s=await create('monto\n'+[1,2,3,4,5,6,7,8,9,1000].join('\n'),{...DEFAULT_RULES,outliers:{...DEFAULT_OUTLIERS,method,factor:method==='zscore'?2:1.5,lower:0,upper:90}});
    expect(s.candidate!.profiles[0].advanced!.outliers).toBe(1);
    expect(s.candidate!.rowsOut).toBe(10);expect(s.candidate!.changedCells).toBe(0);
    expect(s.candidate!.after!.issues.find(i=>i.code==='outlier')?.count).toBe(1);
    s.apply();const output=sink();await exportSession(s,'csv',output,false);expect(output.text).toContain('1000');
  });
  it('does not flag constant columns or too-small samples',async()=>{
    const s=await create('a,b\n4,1\n4,2\n4,3',{...DEFAULT_RULES,outliers:{...DEFAULT_OUTLIERS,method:'iqr'}});
    expect(s.candidate!.profiles.every(p=>p.advanced!.outliers===0)).toBe(true);
  });
});
describe('Custom and cross-column rules',()=>{
  it('validates numeric ranges, dates, digits and allowed categories over originals and proposed data',async()=>{
    const custom=[condition('number-range','monto',{min:0,severity:'critico'}),condition('date-range','fecha',{from:'2020-01-01',to:'2026-12-31'}),condition('digits','CUIT',{length:11}),condition('allowed','provincia',{values:['Buenos Aires']})];
    const s=await create('monto,fecha,CUIT,provincia\n-1,2019-12-31,20-12345678-6,Bs As\n5,2026-12-31,20123456786,Buenos Aires',{
      ...DEFAULT_RULES,custom,categories:[{column:'provincia',from:['Bs As'],to:'Buenos Aires'}]
    });
    const before=s.candidate!.before!, after=s.candidate!.after!;
    expect(before.issues.filter(i=>i.code.startsWith('rule:'))).toHaveLength(4);
    expect(after.issues.filter(i=>i.code.startsWith('rule:'))).toHaveLength(2);
    expect(after.errors).toBe(2);expect(after.severity.critico).toBe(1);
  });
  it('checks date ordering, component sums with tolerance and completed age at an explicit date',async()=>{
    const custom=[condition('date-order','baja',{other:'alta'}),condition('sum','total',{components:['a','b'],tolerance:.01}),condition('age','edad',{other:'nacimiento',asOf:'2026-09-07',tolerance:0})];
    const s=await create('alta,baja,total,a,b,edad,nacimiento\n2024-01-01,2023-12-31,5,2,2,26,2000-09-08\n2020-01-01,2024-01-01,0.3,0.1,0.2,25,2000-09-08',{...DEFAULT_RULES,custom});
    expect(s.candidate!.before!.issues.filter(i=>i.code.startsWith('rule:')).map(i=>i.count)).toEqual([1,1,1]);
    const rule=custom[2], profiles=s.candidate!.profiles;
    expect(ruleFailure(rule,['2020-01-01','2024-01-01','.3','.1','.2','26','2000-09-07'],profiles,s.headers)).toBeNull();
  });
  it('does not make a broken custom rule pass by blanking its operand',async()=>{
    const custom=[condition('number-range','monto',{min:0})];
    const s=await create('monto\n1\n2\n3\n4\nroto',{...DEFAULT_RULES,types:{0:'número'},invalid:'blank',custom});
    expect(s.candidate!.after!.issues.find(i=>i.code.startsWith('rule:'))?.count).toBe(1);
    expect(s.candidate!.after!.issues.find(i=>i.code==='missing')?.count).toBe(1);
  });
  it('separates critical invalid identifiers from informational text',async()=>{
    const s=await create('CUIT,nombre\n20123456789, Ana \n20123456789,Luis\n20123456786,Juan\n20123456786,Sol\n20123456786,Luz');
    expect(s.candidate!.before!.issues.find(i=>i.column==='CUIT')?.severity).toBe('critico');
    expect(s.candidate!.before!.issues.find(i=>i.code==='dirty')?.severity).toBe('informativo');
    expect(s.candidate!.after!.severity.informativo).toBe(0);
  });
  it('recalculates identifier severity after an explicit correction', async()=>{
    const s=await create('CUIT\nbad1\nbad2\n20123456786\n20123456786\n20123456786\n20123456786',{...DEFAULT_RULES,categories:[{column:'CUIT',from:['bad1'],to:'20123456786'}]});
    expect(s.candidate!.before!.issues.find(i=>i.code==='invalid')?.severity).toBe('critico');
    expect(s.candidate!.after!.issues.find(i=>i.code==='invalid')?.severity).toBe('advertencia');
  });
  it('rejects missing columns, malformed rules, overlapping categories and invalid thresholds',()=>{
    expect(()=>validateRules({...DEFAULT_RULES,custom:[condition('sum','a',{components:['a'],tolerance:0})]},['a'])).toThrow('componentes');
    expect(()=>validateRules({...DEFAULT_RULES,custom:[condition('required','ausente')]},['a'])).toThrow('no existe');
    expect(()=>validateRules({...DEFAULT_RULES,categories:[{column:'a',from:['x'],to:'y'},{column:'a',from:['x'],to:'z'}]},['a'])).toThrow('más de un destino');
    expect(()=>validateRules({...DEFAULT_RULES,outliers:{...DEFAULT_OUTLIERS,lower:99,upper:1}},['a'])).toThrow('outliers');
  });
});
describe('Category review, undo and comparative audit',()=>{
  it('groups only selected original values, detects new duplicates and restores prior output',async()=>{
    const s=await create('provincia\nBs As\nBuenos Aires\nBUENOS AIRES\nPcia. Bs. As.');
    s.apply();
    await s.review({...DEFAULT_RULES,categories:[{column:'provincia',from:['Bs As','BUENOS AIRES','Pcia. Bs. As.'],to:'Buenos Aires'}]});
    expect(s.candidate!.changedCells).toBe(3);
    expect(s.candidate!.after!.issues.find(i=>i.code==='duplicate')?.count).toBe(3);
    s.apply();const output=sink();await exportSession(s,'csv',output,false);expect(output.text.match(/Buenos Aires/g)).toHaveLength(4);
    await s.undo();const restored=sink();await exportSession(s,'csv',restored,false);expect(restored.text).toContain('Pcia. Bs. As.');
  });
  it('exports before/after counts and every remaining finding, not only examples',async()=>{
    const s=await create('monto\n'+Array(110).fill('-1').join('\n'),{...DEFAULT_RULES,custom:[condition('number-range','monto',{min:0})]});
    const quality=sink();await exportQuality(s,quality);expect(JSON.parse(quality.text).status).toBe('vista-previa');
    s.apply();const audit=sink();await exportSession(s,'audit',audit,false);
    const result=JSON.parse(audit.text);
    expect(result.pendingIssues.filter((i:{code:string})=>i.code.startsWith('rule:'))).toHaveLength(110);
    expect(result.review.after.errors).toBe(219); // 110 failed conditions + 109 duplicate rows
  });
});
describe('Saved recipes',()=>{
  const memory=()=>{let content:string|null=null;return{getItem:()=>content,setItem:(_key:string,v:string)=>{content=v;}};};
  it('persists and remaps type overrides by column name when the new file is reordered',()=>{
    const rules={...DEFAULT_RULES,types:{0:'identificador' as const},custom:[condition('number-range','monto',{min:0})]};
    const recipe=createRecipe('Impuestos mensual',['id','monto'],rules);
    const storage=memory();saveRecipe(recipe,storage);
    const restored=recipeRules(listRecipes(storage)[0],['monto','id']);
    expect(restored.types).toEqual({1:'identificador'});expect(restored.custom).toEqual(rules.custom);
    expect(()=>recipeRules(recipe,['id'])).toThrow('monto');
    deleteRecipe(recipe.id,storage);expect(listRecipes(storage)).toHaveLength(0);
  });
  it('rejects executable/malformed imported configuration',()=>{
    expect(()=>parseRecipe('{"schemaVersion":2}')).toThrow('incompatible');
    const recipe=createRecipe('test',['id'],DEFAULT_RULES);
    recipe.rules.custom=[{id:'1',column:'id',label:'x',severity:'critico',kind:'eval'} as unknown as ValidationRule];
    expect(()=>parseRecipe(JSON.stringify(recipe))).toThrow('desconocido');
  });
});
describe('Cross-file reconciliation and history',()=>{
  it('compares unique keys, preserves new/removed rows, reports duplicates and never joins empty keys',async()=>{
    const a=await create('id,monto\n1,10\n2,20\n3,100\n4,40\n4,41\n,8\n001,1');
    const b=await create('id,monto\n1,10\n3,30\n4,40\n5,50\n,9\n6,60\n6,61');
    const result=await compareSessions(a,b,{currentKey:'id',referenceKey:'id',normalization:'exact',jumpPercent:25});
    expect(result).toMatchObject({matchedKeys:3,comparableKeys:2,ambiguousKeys:1,modifiedRows:1,unchangedRows:1,newRows:2,removedRows:3,currentDuplicateKeys:1,referenceDuplicateKeys:1,currentDuplicateRows:2,referenceDuplicateRows:2,currentMissingKeys:1,referenceMissingKeys:1});
    expect(result.preview.find(r=>r.kind==='modified')?.changes).toEqual([{column:'monto',before:'30',after:'100',jump:true}]);
    const output=sink();await exportComparison(a,result,output);const report=JSON.parse(output.text);
    expect(report.details).toHaveLength(result.records);
    expect(report.details.filter((r:{kind:string})=>r.kind==='ambiguous')).toHaveLength(3);
  });
  it('normalizes keys only when requested, including distinct key names and zero baselines',async()=>{
    const a=await create('CUIT,monto,nueva\n20-12345678-6,10,x');
    const b=await create('tax,monto,vieja\n20123456786,0,x');
    const literal=await compareSessions(a,b,{currentKey:'CUIT',referenceKey:'tax',normalization:'exact',jumpPercent:25});expect(literal.matchedKeys).toBe(0);
    const r=await compareSessions(a,b,{currentKey:'CUIT',referenceKey:'tax',normalization:'tax-id',jumpPercent:25});
    expect(r.matchedKeys).toBe(1);expect(r.drift[0]).toMatchObject({abrupt:true,meanPercentChange:null});
    expect(r.addedColumns).toEqual(['nueva']);expect(r.removedColumns).toEqual(['vieja']);
    expect(matchingKey('001','text')).not.toBe(matchingKey('1','text'));
    expect(matchingKey(' A  B ','text')).toBe('a b');
  });
  it('detects duplicate keys beyond a storage block and exports beyond the UI preview',async()=>{
    const a=await create('id,monto\n'+Array.from({length:300},(_,i)=>`${i},${i+1}`).join('\n')+'\n0,2');
    const b=await create('id,monto\n'+Array.from({length:300},(_,i)=>`${i},${i}`).join('\n'));
    const r=await compareSessions(a,b,{currentKey:'id',referenceKey:'id',normalization:'exact',jumpPercent:25});
    expect(r.ambiguousKeys).toBe(1);expect(r.modifiedRows).toBe(299);expect(r.preview.filter(x=>x.kind==='modified')).toHaveLength(20);
    const out=sink();await exportComparison(a,r,out);expect(JSON.parse(out.text).details).toHaveLength(302);
  });
  it('cancellation interrupts comparison without modifying either original',async()=>{
    const a=await create('id,monto\n1,2'),b=await create('id,monto\n1,3');
    a.check=()=>{throw new Error('cancelada');};
    await expect(compareSessions(a,b,{currentKey:'id',referenceKey:'id',normalization:'exact',jumpPercent:25})).rejects.toThrow('cancelada');
    expect((await a.storage.get<Row[]>('rows',0))[0].cells).toEqual(['1','2']);
  });
});
