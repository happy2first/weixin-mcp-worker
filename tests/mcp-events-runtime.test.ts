import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

test('workerd: real entrypoint JWT, discovery, upstream ingestion, media refs, atomic read/reply and duplicate event and context state recovery',{timeout:120_000},async()=>{
 const output=mkdtempSync(join(process.cwd(),'.runtime-test-'));
 execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--outdir',output],{stdio:'pipe'});
 const {publicKey,privateKey}=await generateKeyPair('RS256'),jwk={...await exportJWK(publicKey),kid:'test'};
 const token=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'test'}).setSubject('owner').setIssuer('https://test.cloudflareaccess.com').setAudience('test-aud').setExpirationTime('1h').sign(privateKey);
 const mediaKey=Buffer.alloc(16,7),cipher=createCipheriv('aes-128-ecb',mediaKey,null),encrypted=Buffer.concat([cipher.update(Buffer.from('test file')),cipher.final()]);
 const delivered:any[]=[],sent:any[]=[];
 let upstreamMessage=true;
 let inboundId=100, inboundToken='ctx';
 let sendMode: 'ok' | 'invalid' | 'network' | 'refresh' | 'race' | 'without' = 'ok';
 let releaseSend: (() => void) | undefined;
 let sendStarted: (() => void) | undefined;
 const mf=new Miniflare({modules:true,scriptPath:join(output,'chatgpt-file-bridge.js'),compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],durableObjects:{WEIXIN_BOT:{className:'WeixinBotDO',useSQLite:true}},bindings:{TEAM_DOMAIN:'https://test.cloudflareaccess.com',POLICY_AUD:'test-aud',EVENTS_ENCRYPTION_KEY:'a'.repeat(64)},outboundService:async request=>{
  const url=new URL(request.url);
  if(url.hostname==='test.cloudflareaccess.com')return Response.json({keys:[jwk]});
  if(url.hostname==='connectors.api.openai.com'){const b:any=await request.json();if(b.type==='verification')return Response.json({challenge:b.challenge});delivered.push(b);return new Response(null,{status:204})}
  if(url.hostname==='cdn.test')return new Response(encrypted);
  if(url.pathname.endsWith('get_bot_qrcode'))return Response.json({qrcode:'test-qr',qrcode_img_content:'https://test/qr'});
  if(url.pathname.endsWith('get_qrcode_status'))return Response.json({status:'confirmed',bot_token:'test-token',ilink_bot_id:'test-bot',ilink_user_id:'sender',baseurl:'https://ilinkai.weixin.qq.com'});
  if(url.pathname.endsWith('notifystart'))return Response.json({ret:0});
  if(url.pathname.endsWith('getupdates'))return Response.json({ret:0,get_updates_buf:'cursor',msgs:upstreamMessage?[{message_id:inboundId,from_user_id:'sender',message_type:1,context_token:inboundToken,create_time_ms:Date.now(),item_list:[{type:1,text_item:{text:'private inbound text'}},{type:4,file_item:{file_name:'test.txt',len:'9',media:{full_url:'https://cdn.test/file',aes_key:mediaKey.toString('base64')}}}]}]:[]});
  if(url.pathname.endsWith('sendmessage')){
   const body:any=await request.json();sent.push(body);
   if(sendMode==='network')return new Response('unavailable',{status:503});
   if(sendMode==='race'){sendStarted?.();await new Promise<void>(resolve=>{releaseSend=resolve});return Response.json({ret:-2})}
   if((sendMode==='without'&&body.msg.context_token)||sendMode==='invalid'||(sendMode==='refresh'&&body.msg.context_token!==inboundToken))return Response.json({ret:-2,errmsg:'expired'});
   return Response.json({ret:0});
  }
  throw Error('unexpected outbound host');
 }});
 const rpc=async(method:string,params:any={})=>{
  const r=await mf.dispatchFetch('https://worker/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json','cf-access-jwt-assertion':token,'Mcp-Method':method,'MCP-Protocol-Version':'2026-07-28',...(method==='tools/call'?{'Mcp-Name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
  const text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text);
 };
 const tool=async(name:string,args:any={})=>{const r=await rpc('tools/call',{name,arguments:args});assert.ok(!r.result.isError,JSON.stringify(r));return r.result};
 const decode=(r:any)=>JSON.parse(r.content[0].text);
 try{
  assert.equal((await mf.dispatchFetch('https://worker/mcp',{method:'POST',body:'{}'})).status,403);
  const d=await rpc('server/discover');assert.ok(d.result.supportedVersions.includes('2026-07-28'));assert.deepEqual(d.result.capabilities.events,{});
  const list=await rpc('events/list');assert.equal(list.result.events[0].name,'weixin.message.received');
  const tools=await rpc('tools/list');assert.ok(tools.result.tools.find((t:any)=>t.name==='weixin_poll').inputSchema.properties.messageRefs);
  const params={name:'weixin.message.received',arguments:{},delivery:{mode:'webhook',url:'https://connectors.api.openai.com/private',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}};
  assert.ok((await rpc('events/subscribe',params)).result.id);
  const namespace=await mf.getDurableObjectNamespace('WEIXIN_BOT');
  const registry=namespace.get(namespace.idFromName('__registry__')),user=namespace.get(namespace.idFromName('user:tester'));
  const internal=async(stub:any,path:string,body:any)=>{const r=await stub.fetch('https://internal'+path,{method:'POST',body:JSON.stringify(body)});const d:any=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d};
  await internal(registry,'/registry/create',{id:'tester',name:'test'});
  const login=await internal(user,'/login/start',{});await internal(user,'/login/status',{sessionId:login.sessionId});
  await internal(user,'/poll',{userId:'tester',limit:50});
  // Drain durable outbox and callback tasks; all test waits are bounded.
  for(let i=0;i<30&&!delivered.length;i++){await internal(registry,'/events/tick',{});await new Promise(r=>setTimeout(r,20))}
  assert.equal(delivered.length,1);const event=delivered[0];assert.deepEqual(Object.keys(event.data).sort(),['mediaRefs','messageRef']);assert.equal(event.data.mediaRefs.length,1);assert.ok(!JSON.stringify(event).includes('private inbound text'));
  const first=decode(await tool('weixin_poll',{messageRefs:[event.data.messageRef]}));assert.equal(first.messages.length,1);assert.equal(first.messages[0].text,'private inbound text\n[文件] test.txt');assert.ok(first.messages[0].processingToken);
  const media=await tool('weixin_media_get',{mediaRef:event.data.mediaRefs[0]});assert.equal(media.content[1].type,'resource');assert.equal(Buffer.from(media.content[1].resource.blob,'base64').toString(),'test file');
  const duplicate=decode(await tool('weixin_poll',{messageRefs:[event.data.messageRef]}));assert.equal(duplicate.messages.length,0);
  const replyArgs={messageRef:event.data.messageRef,processingToken:first.messages[0].processingToken,text:'test reply'};
  const replied=decode(await tool('weixin_reply',replyArgs));assert.equal(replied.alreadyReplied,false);assert.equal(sent.length,1);
  assert.equal(decode(await tool('weixin_reply',replyArgs)).alreadyReplied,true);assert.equal(sent.length,1);
  // Upstream repeat preserves local ref and does not produce another event.
  await internal(user,'/poll',{userId:'tester'});await internal(registry,'/events/tick',{});assert.equal(delivered.length,1);
  upstreamMessage=false;assert.equal(decode(await tool('weixin_poll')).messages.length,0);
  const status=async()=>decode(await tool('weixin_status')).users[0].status;
  assert.equal((await status()).contextState,'available');
  sendMode='invalid';
  const failed=decode(await tool('weixin_send',{text:'expired test'}));assert.equal(failed.success,false);
  let snapshot=await status();assert.equal(snapshot.connected,true);assert.equal(snapshot.hasContextToken,true);
  assert.equal(snapshot.contextState,'invalid');assert.equal(snapshot.contextNeedsRefresh,true);assert.ok(snapshot.contextInvalidAt);
  // Empty successful polling does not resurrect an invalid context.
  await internal(user,'/poll',{userId:'tester'});assert.equal((await status()).contextState,'invalid');
  upstreamMessage=true;inboundId++;inboundToken='ctx-new';
  await internal(user,'/poll',{userId:'tester'});upstreamMessage=false;
  snapshot=await status();assert.equal(snapshot.contextState,'available');assert.equal(snapshot.contextInvalidAt,null);
  sendMode='network';assert.equal(decode(await tool('weixin_send',{text:'network test'})).success,false);
  assert.equal((await status()).contextState,'available');
  // Recovery receives a new token during its own poll and retries successfully.
  upstreamMessage=true;inboundId++;inboundToken='ctx-recovered';sendMode='refresh';
  const recovered=decode(await tool('weixin_send',{text:'recovery test'}));assert.equal(recovered.success,true);
  assert.equal(recovered.recipients[0].recovery,'refreshed');assert.ok((await status()).contextVerifiedAt);
  upstreamMessage=false;
  // Failure of an old in-flight send must not invalidate a newer inbound token.
  sendMode='race';const started=new Promise<void>(resolve=>{sendStarted=resolve});
  const racing=tool('weixin_send',{text:'race test'});await started;
  upstreamMessage=true;inboundId++;inboundToken='ctx-recovered'; // Same token text, new generation.
  await internal(user,'/poll',{userId:'tester'});upstreamMessage=false;
  sendMode='network';releaseSend!();assert.equal(decode(await racing).success,false);
  assert.equal((await status()).contextState,'available');
  // A fresh token that is also rejected must remain invalid after all fallback attempts.
  upstreamMessage=true;inboundId++;inboundToken='ctx-rejected';sendMode='invalid';
  assert.equal(decode(await tool('weixin_send',{text:'reject fresh token'})).success,false);
  assert.equal((await status()).contextState,'invalid');
  upstreamMessage=false;sendMode='ok';
  assert.equal(decode(await tool('weixin_send',{text:'success clears invalid state'})).success,true);
  assert.equal((await status()).contextState,'available');
  // Legacy fallback is preserved: a context-free success removes the rejected token.
  // Use a dedicated mode where only the context-free request is accepted.
  sendMode='without';
  const contextFree=decode(await tool('weixin_send',{text:'context free'}));assert.equal(contextFree.success,true);
  assert.equal(contextFree.recipients[0].recovery,'without_context');
  snapshot=await status();assert.equal(snapshot.contextState,'missing');assert.equal(snapshot.hasContextToken,false);
  assert.equal(snapshot.contextInvalidAt,null);
  assert.equal((await rpc('events/unsubscribe' ,{...params,delivery:{mode:'webhook',url:params.delivery.url}})).result.resultType,'complete');
 }finally{await mf.dispose();rmSync(output,{recursive:true,force:true})}
});
