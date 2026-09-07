const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const origin = process.env.CLEANER_TEST_URL || 'http://127.0.0.1:5057';
(async () => {
  const browser = await chromium.launch({headless:true,channel:'chrome'});
  try {
    const page=await browser.newPage({viewport:{width:1365,height:1000},acceptDownloads:true});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.goto(origin+'/limpiador');await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
    const headers=['id','CUIT','monto','provincia','alta','baja','total','compA','compB','edad','nacimiento'];
    const rows=Array.from({length:6},(_,i)=>[
      '00'+(i+1),i===0?'20-12345678-6':i===2?'20123456789':'20123456786',[-10,20,30,40,50,1000][i],
      ['Bs As','Buenos Aires','BUENOS AIRES','Pcia. Bs. As.','Buenos Aires','Buenos Aires'][i],
      '2024-01-02',i===0?'2024-01-01':'2024-02-01',i===0?11:10,5,5,i===0?26:25,'2000-09-08']);
    const csv=([headers,...rows].map(row=>row.join(',')).join('\n'));
    const waitStatus=async phrase=>{
      await page.waitForFunction(phrase=>{const s=document.querySelector('#dc-status').textContent;return s.includes(phrase)||s.startsWith('Error:');},phrase,{timeout:30000});
      const value=await page.locator('#dc-status').textContent();if(value.startsWith('Error:'))throw new Error(value);
    };
    const upload=async(buffer)=>{await page.locator('#dc-file').setInputFiles({name:'mensual.csv',mimeType:'text/csv',buffer:Buffer.from(buffer)});await waitStatus('Listo para importar');await page.locator('#dc-import').click();await waitStatus('Perfil completo');};
    const rule=async(kind,column,fill)=>{
      await page.locator('#dc-rule-kind').selectOption(kind);await page.locator('#dc-rule-column').selectOption(column);if(fill)await fill();await page.locator('#dc-rule-add').click();await waitStatus('Regla agregada');
    };
    await upload(csv);
    await rule('number-range','monto',async()=>{await page.locator('#dc-rule-min').fill('0');await page.locator('#dc-rule-severity').selectOption('critico');});
    await rule('digits','CUIT',async()=>{await page.locator('#dc-rule-length').fill('11');});
    await rule('allowed','provincia',async()=>{await page.locator('#dc-rule-values').fill('Buenos Aires');await page.locator('#dc-rule-severity').selectOption('advertencia');});
    await rule('date-order','baja',async()=>{await page.locator('#dc-rule-other').selectOption('alta');});
    await rule('sum','total',async()=>{await page.locator('#dc-rule-components').selectOption(['compA','compB']);await page.locator('#dc-rule-tolerance').fill('0');});
    await rule('age','edad',async()=>{await page.locator('#dc-rule-other').selectOption('nacimiento');await page.locator('#dc-rule-asof').fill('2026-09-07');});
    await page.locator('#dc-outlier-method').selectOption('iqr');await page.locator('#dc-outlier-column').selectOption('monto');
    await page.getByText('Normalización de categorías',{exact:true}).click();
    await page.getByRole('button',{name:'Proponer grupo “Buenos Aires”'}).click();await waitStatus('Agrupación propuesta');
    await page.locator('#dc-preview').click();await waitStatus('Vista previa actualizada');
    assert.match(await page.locator('#dc-quality-summary').textContent(),/10 errores.*6 errores pendientes/);
    await page.locator('#dc-profile-column').selectOption('monto');assert.match(await page.locator('#dc-profile-card').textContent(),/Mediana35/);
    await page.getByText('Recetas reutilizables',{exact:true}).click();
    await page.locator('#dc-recipe-name').fill('Limpieza base impuestos mensual');await page.locator('#dc-recipe-save').click();await waitStatus('Receta guardada');
    let downloaded=page.waitForEvent('download');await page.locator('#dc-recipe-export').click();let file=await downloaded;
    const recipe=JSON.parse(await fs.readFile(await file.path(),'utf8'));assert.equal(recipe.rules.custom.length,6);assert.equal(recipe.rules.categories.length,1);
    await page.locator('#dc-apply').click();await waitStatus('Cambios aplicados');
    downloaded=page.waitForEvent('download');await page.locator('#dc-quality-export').click();file=await downloaded;
    const report=JSON.parse(await fs.readFile(await file.path(),'utf8'));assert.equal(report.status,'aplicado');assert.equal(report.before.errors,10);assert.equal(report.after.errors,6);
    downloaded=page.waitForEvent('download');await page.locator('#dc-audit').click();file=await downloaded;
    const audit=JSON.parse(await fs.readFile(await file.path(),'utf8'));assert.equal(audit.pendingIssues.filter(i=>i.severity!=='informativo').length,6);
    console.log('Custom rules, severity, categories, outliers and comparative reports OK');
    // Persist across reload and match schema by column names after reorder.
    await page.reload();await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
    await upload([headers,...rows].map(row=>[...row].reverse().join(',')).join('\n'));
    await page.getByText('Recetas reutilizables',{exact:true}).click();
    await page.locator('#dc-recipe-load').click();await waitStatus('cargada por nombres');
    await page.locator('#dc-preview').click();await waitStatus('Vista previa actualizada');
    assert.match(await page.locator('#dc-quality-summary').textContent(),/10 errores.*6 errores pendientes/);
    console.log('Saved recipe survives reload and column reorder');
    await page.locator('#dc-reference-file').setInputFiles(path.resolve(__dirname,'../../../cleaner/tests/fixtures/reference.xlsx'));
    await page.waitForFunction(()=>document.querySelector('#dc-reference-info').textContent.includes('listo para importar'));
    await page.locator('#dc-reference-import').click();await waitStatus('Referencia importada');
    await page.locator('#dc-compare-current-key').selectOption('id');await page.locator('#dc-compare-reference-key').selectOption('id');
    await page.locator('#dc-compare-run').click();await waitStatus('Cruce completo');
    downloaded=page.waitForEvent('download');await page.locator('#dc-compare-export').click();file=await downloaded;
    const comparison=JSON.parse(await fs.readFile(await file.path(),'utf8'));
    assert.equal(comparison.matchedKeys,4);assert.equal(comparison.modifiedRows,2);assert.equal(comparison.newRows,2);assert.equal(comparison.removedRows,1);assert.equal(comparison.ambiguousKeys,1);assert.equal(comparison.details.length,9);
    await page.locator('#dc-compare-filter').selectOption('ambiguous');assert.equal(await page.locator('#dc-compare-rows tr').count(),3);
    assert.equal(errors.length,0,errors.join('\n'));
    if(process.env.CLEANER_SCREENSHOT) await page.screenshot({path:process.env.CLEANER_SCREENSHOT,fullPage:true});
    console.log('CSV ↔ Excel historical comparison and full export OK');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
