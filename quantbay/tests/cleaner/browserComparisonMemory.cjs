const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  let poll;
  try {
    const page=await browser.newPage();await page.goto((process.env.CLEANER_TEST_URL||'http://127.0.0.1:5057')+'/limpiador');
    const status=async phrase=>{
      await page.waitForFunction(p=>{const s=document.querySelector('#dc-status').textContent;return s.includes(p)||s.startsWith('Error:');},phrase,{timeout:300000});
      const text=await page.locator('#dc-status').textContent();if(text.startsWith('Error:'))throw new Error(text);
    };
    await page.locator('#dc-file').setInputFiles(process.env.CLEANER_LARGE_FILE);await status('Listo para importar');
    const ready=page.waitForEvent('worker'),start=Date.now();await page.locator('#dc-import').click();await ready;
    const client=await browser.newBrowserCDPSession();const {targetInfos}=await client.send('Target.getTargets');
    const target=targetInfos.find(t=>t.type==='worker');const {sessionId}=await client.send('Target.attachToTarget',{targetId:target.targetId});
    let id=0,peak=0,samples=0;
    client.on('Target.receivedMessageFromTarget',({message})=>{const r=JSON.parse(message).result;if(r?.usedSize){peak=Math.max(peak,r.usedSize+(r.backingStorageSize||0));samples++;}});
    poll=setInterval(()=>client.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:++id,method:'Runtime.getHeapUsage'})}).catch(()=>{}),250);
    await status('Perfil completo');console.log('Actual seconds',(Date.now()-start)/1000);
    const refStart=Date.now();await page.locator('#dc-reference-file').setInputFiles(process.env.CLEANER_REFERENCE_FILE);
    await page.waitForFunction(()=>document.querySelector('#dc-reference-info').textContent.includes('listo para importar'));
    await page.locator('#dc-reference-import').click();await status('Referencia importada');console.log('Reference seconds',(Date.now()-refStart)/1000);
    const compareStart=Date.now();await page.locator('#dc-compare-current-key').selectOption('id');await page.locator('#dc-compare-reference-key').selectOption('id');await page.locator('#dc-compare-run').click();await status('Cruce completo');
    const summary=await page.locator('#dc-compare-summary').textContent();assert.match(summary,/99\.990 claves en ambos/);assert.match(summary,/10 nuevas.*10 eliminadas/);
    console.log(JSON.stringify({comparisonSeconds:(Date.now()-compareStart)/1000,totalSeconds:(Date.now()-start)/1000,peakWorkerHeapMiB:peak/1024**2,samples,summary}));
  } finally {clearInterval(poll);await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
