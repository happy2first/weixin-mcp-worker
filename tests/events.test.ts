import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { WeixinEvents, signature, callbackUrl, expiration, authorized, eventIdentityParams } from '../src/events.ts';
import { claimMessages, beginReply } from '../src/message-processing.ts';
import { eventDiagnostic } from '../src/events-diagnostics.ts';
const secret='whsec_'+Buffer.alloc(32,7).toString('base64');
const env:any={EVENTS_ENCRYPTION_KEY:'a'.repeat(64)};
const raw=(key=secret)=>({name:'weixin.message.received',arguments:{},delivery:{mode:'webhook',url:'https://connectors.api.openai.com/callback/private-token',secret:key}});
function fixture(){
 const db=new DatabaseSync(':memory:');
 const ctx:any={storage:{sql:{exec(q:string,...args:any[]){const rows=db.prepare(q).all(...args);return {toArray:()=>rows}}},transactionSync(fn:any){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}}};
 const events=new WeixinEvents(ctx,env);return {db,ctx,events};
}
function mock(handler?:any){
 const original=globalThis.fetch,requests:Request[]=[];
 globalThis.fetch=(async(input:any,init:any)=>{const r=new Request(input,init);requests.push(r.clone());const b:any=await r.json();if(b.type==='verification')return Response.json({challenge:b.challenge});return handler?handler(r):new Response(null,{status:204})}) as typeof fetch;
 return {requests,restore(){globalThis.fetch=original}};
}
test('defaults require verified nonempty subject, only explicit false disables Events',()=>{
 assert.ok(authorized('owner',env));assert.ok(authorized('other',env));assert.ok(!authorized('',env));assert.ok(!authorized('owner',{...env,EVENTS_ENABLED:'false'}));
 assert.equal(callbackUrl(raw().delivery.url,env),raw().delivery.url);
 for(const url of ['http://connectors.api.openai.com/x','https://127.0.0.1/x','https://[::1]/x','https://localhost/x','https://connectors.api.openai.com.evil.org/x','https://evil.org/x','https://u@connectors.api.openai.com/x','https://connectors.api.openai.com:8443/x','https://connectors.api.openai.com/x#token','https://api.openai.com/x'])assert.throws(()=>callbackUrl(url,env));
 assert.throws(()=>callbackUrl('https://evil.org/x',{...env,EVENTS_CALLBACK_HOSTS:'evil.org'}));
 assert.throws(()=>callbackUrl(raw().delivery.url,{...env,EVENTS_CALLBACK_HOSTS:'chatgpt.com'}));
 assert.equal(callbackUrl('https://chatgpt.com/x',{...env,EVENTS_CALLBACK_HOSTS:'chatgpt.com'}),'https://chatgpt.com/x');
});
test('independent Standard Webhooks HMAC over exact UTF-8 bytes',async()=>{
 const body='{"x":"珠海"}';assert.equal(await signature(secret,'evt_1',123,body),'v1,'+createHmac('sha256',Buffer.alloc(32,7)).update(`evt_1.123.${body}`).digest('base64'));
 assert.notEqual(await signature(secret,'evt_1',123,body),await signature(secret,'evt_1',124,body));
});
test('finite TTL and minimal event filters validation',()=>{
 assert.equal(expiration(null,0),86400000);assert.equal(expiration(1e12,0),604800000);for(const t of [0,-1,'1',NaN,1.5])assert.throws(()=>expiration(t,0));
 assert.throws(()=>eventIdentityParams({...raw(),arguments:{owner:'other'}}));
});
test('signed challenge, encrypted callback and secret, renewal and rotation',async()=>{
 const f=fixture(),m=mock();try{
 const sub:any=await f.events.request('events/subscribe','owner',raw());
 const r=m.requests[0],body=await r.text();assert.equal(r.redirect,'manual');assert.equal(r.headers.get('webhook-signature'),await signature(secret,r.headers.get('webhook-id')!,Number(r.headers.get('webhook-timestamp')),body));
 const row:any=f.db.prepare('SELECT * FROM event_subscriptions').get();assert.notEqual(row.secret,secret);assert.notEqual(row.url,raw().delivery.url);assert.ok(!JSON.stringify(row).includes('private-token'));
 assert.equal((await f.events.request('events/subscribe','owner',{...raw(),ttlMs:120000}) as any).id,sub.id);assert.equal(m.requests.length,1);
 const rotated='whsec_'+Buffer.alloc(32,8).toString('base64');await f.events.request('events/subscribe','owner',raw(rotated));
 await f.events.enqueue('user:wxmsg_1',['user:wxmedia_1'],'2026-10-02T12:00:00Z');await f.events.tick();
 const event=m.requests[2];assert.equal(event.headers.get('webhook-signature')!.split(' ').length,2);
 }finally{m.restore();f.db.close()}
});
test('subjects cannot modify each other subscriptions; disabled and missing sub denied',async()=>{
 const f=fixture(),m=mock();try{
 await f.events.request('events/subscribe','alice',raw());await f.events.request('events/unsubscribe','bob',raw());assert.equal(f.db.prepare('SELECT COUNT(*) n FROM event_subscriptions').get()!.n,1);
 await f.events.request('events/subscribe','bob',raw());assert.equal(f.db.prepare('SELECT COUNT(*) n FROM event_subscriptions').get()!.n,2);
 await assert.rejects(f.events.request('events/list','',{}),{reason:'events_access_denied'});
 await assert.rejects(new WeixinEvents(f.ctx,{...env,EVENTS_ENABLED:'false'}).request('events/list','alice',{}),{reason:'events_access_denied'});
 }finally{m.restore();f.db.close()}
});
test('failed, redirect, oversized or wrong challenges do not activate',async()=>{
 const f=fixture(),old=globalThis.fetch;try{
 for(const response of [Response.json({challenge:'wrong'}),new Response(null,{status:302}),new Response('x'.repeat(4097)),new Response(null,{status:410})]){
 globalThis.fetch=(async()=>response) as typeof fetch;await assert.rejects(f.events.request('events/subscribe','owner',raw()),{reason:'challenge_failed'});
 }
 globalThis.fetch=(async()=>{throw new DOMException('timeout','TimeoutError')}) as typeof fetch;await assert.rejects(f.events.request('events/subscribe','owner',raw()),{reason:'timeout'});
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM event_subscriptions').get()!.n,0);
 }finally{globalThis.fetch=old;f.db.close()}
});
test('missing encryption secret fails before network and unsupported replay rejected',async()=>{
 const f=fixture(),m=mock();try{
 await assert.rejects(new WeixinEvents(f.ctx,{} as any).request('events/subscribe','owner',raw()),{reason:'missing_events_encryption_key'});assert.equal(m.requests.length,0);
 await assert.rejects(f.events.request('events/subscribe','owner',{...raw(),cursor:'old'}),{reason:'replay_not_supported'});
 }finally{m.restore();f.db.close()}
});
test('no messages is silent, duplicate ingest and ticks stable; payload references only',async()=>{
 const f=fixture(),m=mock();try{
 assert.equal(await f.events.enqueue('user:wxmsg_1',[],'2026-10-02T12:00:00Z'),false);
 await f.events.request('events/subscribe','owner',raw());await f.events.tick();assert.equal(m.requests.length,1);
 await f.events.enqueue('user:wxmsg_1',['user:wxmedia_1'],'2026-10-02T12:00:00Z');await f.events.tick();await f.events.enqueue('user:wxmsg_1',['user:wxmedia_1'],'2026-10-02T12:00:00Z');await f.events.tick();assert.equal(m.requests.length,2);
 const b:any=await m.requests[1].json();assert.deepEqual(b.data,{messageRef:'user:wxmsg_1',mediaRefs:['user:wxmedia_1']});assert.equal(b.eventId,m.requests[1].headers.get('webhook-id'));
 }finally{m.restore();f.db.close()}
});
test('all failure statuses keep subscription and retry exact event across restart',async()=>{
 for(const status of [410,413,302,429,503,0]){
 const f=fixture(),m=mock(()=>{if(!status)throw Error('network');return new Response(null,{status})});try{
 await f.events.request('events/subscribe','owner',raw());await f.events.enqueue('user:wxmsg_1',[],'2026-10-02T12:00:00Z');await f.events.tick();
 f.db.prepare('UPDATE event_deliveries SET attempts=12,retry_at=0').run();await new WeixinEvents(f.ctx,env).tick();
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM event_subscriptions').get()!.n,1);assert.equal(f.db.prepare('SELECT status FROM event_deliveries').get()!.status,'pending');
 assert.equal(await m.requests[1].text(),await m.requests[2].text());assert.equal(m.requests[1].headers.get('webhook-id'),m.requests[2].headers.get('webhook-id'));
 }finally{m.restore();f.db.close()}
 }
});
test('expiration and explicit unsubscribe cancel delivery; concurrent unsubscribe prevents resurrection',async()=>{
 const f=fixture(),m=mock();try{
 await f.events.request('events/subscribe','owner',raw());await f.events.enqueue('user:wxmsg_1',[],'2026-10-02T12:00:00Z');f.db.prepare('UPDATE event_subscriptions SET expires=0').run();await f.events.tick();assert.equal(m.requests.length,1);
 await f.events.request('events/subscribe','owner',raw());await f.events.request('events/unsubscribe','owner',raw());await f.events.request('events/unsubscribe','owner',raw());assert.equal(f.db.prepare('SELECT COUNT(*) n FROM event_subscriptions').get()!.n,0);
 }finally{m.restore();f.db.close()}
 const g=fixture(),old=globalThis.fetch;let release:any,enter:any;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 globalThis.fetch=(async(_:any,init:any)=>{enter();await gate;return Response.json({challenge:JSON.parse(init.body).challenge})}) as typeof fetch;
 try{const p=g.events.request('events/subscribe','owner',raw());await ready;await g.events.request('events/unsubscribe','owner',raw());release();await assert.rejects(p,{reason:'subscription_changed_retry'});}finally{globalThis.fetch=old;g.db.close()}
});
test('atomic processing leases, expiry, tokens and uncertain reply suppress duplicate execution',()=>{
 const f=fixture();try{
 f.db.exec("CREATE TABLE messages(message_ref TEXT PRIMARY KEY,direction TEXT,status TEXT);CREATE TABLE message_processing(message_ref TEXT PRIMARY KEY,token TEXT,lease_until INTEGER,reply_state TEXT);INSERT INTO messages VALUES('wxmsg_1','inbound','pending')");
 const a=claimMessages(f.ctx,['wxmsg_1','wxmsg_1']);assert.equal(a.messages.length,1);assert.equal(claimMessages(f.ctx,['wxmsg_1']).messages.length,0);
 assert.throws(()=>beginReply(f.ctx,'wxmsg_1','wrong'),/lease_conflict/);
 f.db.prepare('UPDATE message_processing SET lease_until=0').run();const b=claimMessages(f.ctx,['wxmsg_1']);assert.equal(b.messages.length,1);assert.notEqual(a.processingToken,b.processingToken);
 beginReply(f.ctx,'wxmsg_1',b.processingToken);assert.throws(()=>beginReply(f.ctx,'wxmsg_1',b.processingToken),/uncertain/);assert.equal(claimMessages(f.ctx,['wxmsg_1']).messages.length,0);
 f.db.prepare("UPDATE message_processing SET reply_state='uncertain'").run();assert.equal(claimMessages(f.ctx,['wxmsg_1']).messages.length,0);
 }finally{f.db.close()}
});
test('diagnostics never copy callback path, key, message body or arbitrary reasons',()=>{
 const data=eventDiagnostic('events/subscribe',{...raw(),text:'private body'},false,{reason:'private body'},true,true);
 const text=JSON.stringify(data);assert.ok(text.includes('connectors.api.openai.com'));for(const value of ['private-token',secret,'private body'])assert.ok(!text.includes(value));assert.equal(data.reason,'internal_error');
});
