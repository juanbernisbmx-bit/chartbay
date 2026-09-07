const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage();
await page.goto((process.env.CLEANER_TEST_URL || 'http://127.0.0.1:5057') + '/limpiador');
await page.locator('#dc-file').setInputFiles(process.env.CLEANER_LARGE_FILE);
await page.waitForFunction(()=>document.querySelector('#dc-status').textContent.includes('Listo para importar'));
const start=Date.now();
const workerReady=page.waitForEvent('worker');
await page.locator('#dc-import').click(); await workerReady;
const client=await browser.newBrowserCDPSession();
const {targetInfos}=await client.send('Target.getTargets');
const target=targetInfos.find(t=>t.type==='worker');
const {sessionId}=await client.send('Target.attachToTarget',{targetId:target.targetId});
let id=0,peak=0, samples=0;
client.on('Target.receivedMessageFromTarget',({message})=>{const data=JSON.parse(message);if(data.result?.usedSize){peak=Math.max(peak,data.result.usedSize+(data.result.backingStorageSize||0));samples++;}});
const poll=setInterval(()=>client.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:++id,method:'Runtime.getHeapUsage'})}).catch(()=>{}),250);
await page.waitForFunction(()=>document.querySelector('#dc-status').textContent.includes('Perfil completo')||document.querySelector('#dc-status').textContent.startsWith('Error'),null,{timeout:240000});
clearInterval(poll);
console.log(JSON.stringify({status:await page.locator('#dc-status').textContent(),summary:await page.locator('#dc-summary').textContent(),seconds:(Date.now()-start)/1000,peakWorkerHeapMiB:peak/1024**2,samples}));
// Cancellation must leave apply/export unavailable, then a new import must work.
await page.locator('#dc-duplicates').check();await page.locator('#dc-preview').click();await page.locator('#dc-cancel').click();
await page.waitForFunction(()=>document.querySelector('#dc-status').textContent.includes('cancelada'),null,{timeout:10000});
console.log('cancel',await page.locator('#dc-status').textContent(),'applyDisabled',await page.locator('#dc-apply').isDisabled());
await page.locator('#dc-file').setInputFiles({name:'small.csv',mimeType:'text/csv',buffer:Buffer.from('a,b\n1,2')});
await page.locator('#dc-import').click();await page.waitForFunction(()=>document.querySelector('#dc-status').textContent.includes('Perfil completo'));
console.log('reimport',await page.locator('#dc-status').textContent());
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
