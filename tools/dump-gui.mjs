import { execFileSync } from 'node:child_process'
import { CDP, launchChrome, sleep } from '../probe/cdp.mjs'
const ORIGIN='http://127.0.0.1:3080'
const cookie=JSON.parse(execFileSync(process.execPath,['tools/auth-cookie.mjs','--json'],{encoding:'utf8'}))
const chrome=await launchChrome({headless:true,width:1400,height:950})
const cdp=await CDP.connect(chrome.browserWsUrl)
const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'})
const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true})
const send=(m,p={})=>cdp.send(m,p,sessionId)
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Network.setCookie',{name:cookie.name,value:cookie.value,url:ORIGIN,path:'/',httpOnly:true,sameSite:'Strict'})
await send('Page.navigate',{url:ORIGIN+'/'}); await sleep(3000)
const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails) return {__error:r.exceptionDetails.text,desc:r.result?.description};return r.result?.value}
console.log(JSON.stringify(await ev(`(() => {
 const out=[];
 for (const el of document.querySelectorAll('button,[role="button"],a')) {
   const label=el.getAttribute('aria-label')||''; const text=(el.textContent||'').trim().slice(0,40);
   if(!label&&!text) continue;
   out.push({tag:el.tagName,label,text,data:[...el.attributes].map(a=>a.name).filter(n=>n.startsWith('data-')).slice(0,4)});
 }
 return {title:document.title, url:location.href, buttons:out.slice(0,90), bodyText:(document.body.innerText||'').slice(0,800)};
})()`),null,1))
await chrome.kill(); process.exit(0)
