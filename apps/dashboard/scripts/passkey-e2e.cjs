/**
 * End-to-end check of attached cards with a REAL passkey ceremony, using Chromium's virtual authenticator.
 * Start the API (ACARD_ATTACHED_CARDS_PROVIDER=test DASHBOARD_URL=http://localhost:3000) and the dashboard on :3000, then:
 *   node apps/dashboard/scripts/passkey-e2e.cjs
 * Screenshots land in /tmp/shots. Uses a fresh in-memory API (it registers owner@example.co.za).
 */
const { chromium } = require("playwright");
const API="http://localhost:8787";
const j=async(r)=>r.json();
(async()=>{
 const reg=await j(await fetch(API+"/v1/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"owner@example.co.za",name:"Owner",password:"a-long-test-password-123",currency:"ZAR",account_type:"enterprise"})}));
 const sess=reg.session_token; const H=(t)=>({authorization:"Bearer "+t,"content-type":"application/json"});
 const key=(await j(await fetch(API+"/v1/keys",{method:"POST",headers:H(sess),body:JSON.stringify({name:"agent"})}))).api_key;
 const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1280,height:900}}); const p=await ctx.newPage(); const errs=[]; p.on("pageerror",e=>errs.push(e.message));
 const cdp=await ctx.newCDPSession(p); await cdp.send("WebAuthn.enable"); await cdp.send("WebAuthn.addVirtualAuthenticator",{options:{protocol:"ctap2",transport:"internal",hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 await p.goto("http://localhost:3000"); await p.evaluate((t)=>{localStorage.setItem("acard_token",t);localStorage.setItem("acard_last_product","acard");},sess); await p.reload();
 await p.waitForSelector("text=Manage cards",{timeout:30000});
 await p.click(".nav-item:has-text('Wallet')"); await p.click("[role=tab]:has-text('Your cards')"); await p.waitForSelector("text=PASSKEY");
 await p.click("button:has-text(\"Add a passkey\")"); await p.waitForSelector("text=1 passkey registered",{timeout:5000});
 await p.click("button:has-text('visa •••• 4242')"); await p.waitForSelector("text=Visa •••• 4242");
 // agent asks to pay R900 with an API key
 const pur=await j(await fetch(API+"/v1/attached-cards/purchases",{method:"POST",headers:H(key),body:JSON.stringify({amount:90000,currency:"ZAR",merchant_name:"Fresh Basket",merchant_category:"5411",checkout:{method:"network_token",destination:"acq:fresh"}})}));
 const agentTry=await fetch(API+`/v1/attached-cards/purchases/${pur.purchase.id}/approval-options`,{method:"POST",headers:H(key),body:"{}"});
 await p.click("[role=tab]:has-text('Fiat')"); await p.click("[role=tab]:has-text('Your cards')"); await p.waitForSelector("text=WAITING FOR YOUR PASSKEY");
 await p.screenshot({path:"/tmp/shots/dash-cards-waiting.png",fullPage:true});
 await p.click("text=Approve with passkey"); await p.waitForSelector("text=your rule, text=owner@example.co.za",{timeout:10000}).catch(()=>{});
 await p.waitForTimeout(800);
 const list=await j(await fetch(API+"/v1/attached-cards/purchases",{headers:H(sess)}));
 await p.screenshot({path:"/tmp/shots/dash-cards-paid.png",fullPage:true});
 console.log(JSON.stringify({first:pur.purchase.status, agentCanApprove:agentTry.status, after:list.purchases[0].status, by:list.purchases[0].approved_by, errs}));
 await b.close();})();
