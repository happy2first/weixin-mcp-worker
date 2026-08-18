export const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>微信 ClawBot MCP 管理</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    body { margin:0; background:#f5f6f8; color:#111; }
    main { max-width:980px; margin:0 auto; padding:24px 16px 56px; }
    h1 { margin:0 0 4px; font-size:26px; }
    h2 { margin:0 0 14px; font-size:19px; }
    h3 { margin:0 0 8px; font-size:17px; }
    p { line-height:1.55; }
    .muted { color:#667085; font-size:14px; }
    .card { background:#fff; border-radius:16px; padding:18px; margin:14px 0; box-shadow:0 1px 8px rgba(0,0,0,.06); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; }
    .user { border:1px solid #e4e7ec; border-radius:14px; padding:14px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .between { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
    input, textarea { width:100%; box-sizing:border-box; padding:10px 11px; border:1px solid #d0d5dd; border-radius:9px; font-size:15px; margin:5px 0 9px; font-family:inherit; }
    textarea { min-height:86px; resize:vertical; }
    label { font-size:13px; color:#475467; display:block; }
    button { border:0; border-radius:9px; padding:9px 12px; cursor:pointer; background:#111; color:#fff; font-size:14px; }
    button.secondary { background:#eaecf0; color:#111; }
    button.danger { background:#b42318; }
    button.small { padding:6px 9px; font-size:12px; }
    .pill { display:inline-block; padding:3px 8px; border-radius:999px; font-size:12px; background:#eaecf0; }
    .ok { background:#dcfae6; color:#067647; }
    .warn { background:#fef0c7; color:#93370d; }
    .off { background:#f2f4f7; color:#667085; }
    pre { white-space:pre-wrap; word-break:break-word; background:#f2f4f7; padding:10px; border-radius:9px; font-size:12px; max-height:260px; overflow:auto; }
    #qr svg { width:min(75vw,320px); height:auto; background:#fff; padding:10px; border-radius:10px; }
    .message { border-top:1px solid #eaecf0; padding:12px 0; }
    .message:first-child { border-top:0; }
    .message-text { white-space:pre-wrap; word-break:break-word; margin:7px 0; line-height:1.5; }
    .meta { display:flex; gap:8px; flex-wrap:wrap; font-size:12px; color:#667085; }
    .two { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    @media(max-width:620px){ .two{grid-template-columns:1fr;} .between{display:block;} }
    @media(prefers-color-scheme:dark){
      body{background:#111318;color:#f3f4f6}.card{background:#1b1e24}.user{border-color:#343a46}
      input,textarea{background:#111318;border-color:#475467;color:#fff}.muted,label,.meta{color:#aeb3bd}
      pre{background:#111318}.message{border-color:#343a46}button.secondary{background:#353941;color:#fff}
    }
  </style>
</head>
<body>
<main>
  <h1>微信 ClawBot MCP 管理</h1>
  <p class="muted">v0.3 · 多用户绑定、消息历史、异步轮询与回复。敏感 token 不在页面展示。</p>

  <section class="card">
    <div class="between"><h2>微信用户</h2><button class="secondary" onclick="loadUsers()">刷新</button></div>
    <div id="users" class="grid"><div class="muted">正在读取...</div></div>
  </section>

  <section class="card">
    <h2>添加微信用户</h2>
    <div class="two">
      <div><label>用户标识（给 ChatGPT 使用）</label><input id="newId" placeholder="例如 zhenhua / wife" /></div>
      <div><label>显示名称</label><input id="newName" placeholder="例如 振华 / 老婆" /></div>
    </div>
    <button onclick="addUser()">添加用户</button>
    <span id="addResult" class="muted"></span>
  </section>

  <section class="card" id="bindCard" style="display:none">
    <h2>扫码绑定</h2>
    <div id="bindTitle" class="muted"></div>
    <div id="qr" style="margin:14px 0"></div>
    <div id="loginMessage" class="muted"></div>
    <div id="verifyBox" style="display:none;margin-top:10px">
      <label>微信显示的配对数字</label>
      <input id="verifyCode" inputmode="numeric" placeholder="输入配对数字" />
      <button onclick="submitVerifyCode()">提交</button>
    </div>
  </section>

  <section class="card">
    <div class="between"><h2>消息记录</h2><button class="secondary" onclick="loadMessages()">刷新</button></div>
    <p class="muted">保存文本内容、方向、状态和多模态元数据。当前不把图片/文件/语音二进制存进 Durable Object。</p>
    <div id="messages"><div class="muted">正在读取...</div></div>
  </section>

  <section class="card">
    <h2>系统说明</h2>
    <pre>ChatGPT MCP: /mcp
管理后台: /admin
兼容入口: /setup → /admin

多模态入站：文本 / 图片 / 语音 / 文件 / 视频类型和安全元数据可记录；语音若微信返回转写文本会一并保存。
二进制长期留存：建议后续绑定 R2，不把大文件写入 DO。</pre>
  </section>
</main>
<script>
let currentUserId = null;
let currentSession = null;
let loginPolling = false;

async function api(path, body) {
  const options = body === undefined ? { method:'GET' } : { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body||{}) };
  const res = await fetch('/admin/api' + path, options);
  const data = await res.json().catch(() => ({ message:'返回内容不是 JSON' }));
  if (!res.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status));
  return data;
}
function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function statusPill(status, enabled){
  if (!enabled) return '<span class="pill off">已停用</span>';
  return status && status.connected ? '<span class="pill ok">已绑定</span>' : '<span class="pill warn">未绑定</span>';
}

async function loadUsers(){
  const el=document.getElementById('users');
  try{
    const data=await api('/users');
    const users=data.users||[];
    if(!users.length){el.innerHTML='<div class="muted">还没有微信用户。先在下方添加一个，再扫码绑定。</div>';return;}
    el.innerHTML=users.map(function(u){
      const s=u.status||{};
      return '<div class="user">'+
        '<div class="between"><div><h3>'+esc(u.name)+'</h3><div class="muted">'+esc(u.id)+'</div></div><div>'+statusPill(s,u.enabled)+(u.isDefault?' <span class="pill ok">默认</span>':'')+'</div></div>'+
        '<label>显示名称</label><input id="name_'+esc(u.id)+'" value="'+esc(u.name)+'" />'+
        '<div class="row">'+
          '<button class="small" onclick="saveUser(\''+esc(u.id)+'\')">保存名称</button>'+
          '<button class="small secondary" onclick="toggleUser(\''+esc(u.id)+'\','+(!u.enabled)+')">'+(u.enabled?'停用':'启用')+'</button>'+
          (!u.isDefault?'<button class="small secondary" onclick="makeDefault(\''+esc(u.id)+'\')">设为默认</button>':'')+
        '</div><div class="row" style="margin-top:8px">'+
          '<button class="small" onclick="startBind(\''+esc(u.id)+'\',\''+esc(u.name)+'\')">'+(s.connected?'重新绑定':'扫码绑定')+'</button>'+
          '<button class="small secondary" onclick="testSend(\''+esc(u.id)+'\')">测试发送</button>'+
          '<button class="small secondary" onclick="testPoll(\''+esc(u.id)+'\')">拉取回复</button>'+
          '<button class="small secondary" onclick="clearMessages(\''+esc(u.id)+'\')">清空消息</button>'+
          '<button class="small danger" onclick="deleteUser(\''+esc(u.id)+'\',\''+esc(u.name)+'\')">删除用户</button>'+
        '</div>'+
        '<pre>'+esc(JSON.stringify({connected:s.connected||false,pendingInbound:s.pendingInbound||0,messageCount:s.messageCount||0,lastPollAt:s.lastPollAt||null,lastPollError:s.lastPollError||null},null,2))+'</pre>'+
      '</div>';
    }).join('');
  }catch(e){el.innerHTML='<div class="warn">错误：'+esc(e.message)+'</div>';}
}

async function addUser(){
  const id=document.getElementById('newId').value.trim();
  const name=document.getElementById('newName').value.trim();
  try{
    const data=await api('/users/create',{id:id,name:name});
    document.getElementById('addResult').textContent='已添加 '+data.user.name;
    document.getElementById('newId').value=''; document.getElementById('newName').value='';
    await loadUsers();
  }catch(e){document.getElementById('addResult').textContent='错误：'+e.message;}
}
async function saveUser(id){ try{await api('/users/update',{id:id,name:document.getElementById('name_'+id).value});await loadUsers();}catch(e){alert(e.message);} }
async function toggleUser(id,enabled){ try{await api('/users/update',{id:id,enabled:enabled});await loadUsers();}catch(e){alert(e.message);} }
async function makeDefault(id){ try{await api('/users/update',{id:id,isDefault:true});await loadUsers();}catch(e){alert(e.message);} }
async function deleteUser(id,name){
  if(!confirm('删除“'+name+'”会同时清除该用户在 Cloudflare DO 中的绑定凭证、游标和消息历史。确定删除？'))return;
  try{await api('/users/delete',{id:id});await loadUsers();await loadMessages();}catch(e){alert(e.message);}
}
async function clearMessages(id){
  if(!confirm('确定清空 '+id+' 的全部收发消息历史？绑定关系不会删除。'))return;
  try{await api('/messages/clear',{userId:id});await loadUsers();await loadMessages();}catch(e){alert(e.message);}
}

async function startBind(id,name){
  currentUserId=id; currentSession=null;
  document.getElementById('bindCard').style.display='block';
  document.getElementById('bindTitle').textContent='正在为 '+name+' ('+id+') 生成二维码';
  document.getElementById('qr').innerHTML=''; document.getElementById('verifyBox').style.display='none';
  try{
    const data=await api('/login/start',{userId:id});
    currentSession=data.sessionId;
    document.getElementById('qr').innerHTML=data.qrSvg||'';
    document.getElementById('loginMessage').textContent='请用对应微信扫码并确认。';
    pollLogin();
  }catch(e){document.getElementById('loginMessage').textContent='错误：'+e.message;}
}
async function pollLogin(verifyCode){
  if(!currentUserId||!currentSession||loginPolling)return;
  loginPolling=true;
  try{
    const data=await api('/login/status',{userId:currentUserId,sessionId:currentSession,verifyCode:verifyCode});
    document.getElementById('loginMessage').textContent=data.message||data.status||'';
    if(data.needsVerifyCode){document.getElementById('verifyBox').style.display='block';return;}
    document.getElementById('verifyBox').style.display='none';
    if(data.connected){document.getElementById('qr').innerHTML='<div class="pill ok">绑定成功</div>';currentSession=null;await loadUsers();return;}
    if(data.status==='expired'||data.status==='verify_code_blocked')return;
  }catch(e){document.getElementById('loginMessage').textContent='轮询错误：'+e.message;}
  finally{loginPolling=false;}
  if(currentSession)setTimeout(function(){pollLogin();},1200);
}
async function submitVerifyCode(){const code=document.getElementById('verifyCode').value.trim();if(!code)return;document.getElementById('verifyBox').style.display='none';await pollLogin(code);}

async function testSend(id){
  const text=prompt('发送测试内容：','weixin-mcp-worker 测试消息：如果你看到这条消息，说明发送链路已打通。');
  if(text===null)return;
  try{const data=await api('/send',{userId:id,text:text});alert(JSON.stringify(data,null,2));await loadMessages();}catch(e){alert(e.message);}
}
async function testPoll(id){
  try{
    const data=await api('/poll',{userId:id,limit:20});
    alert(JSON.stringify(data,null,2));
    if(data.messages&&data.messages.length){
      const first=data.messages[0];
      if(confirm('拉到待处理消息：\n'+first.text+'\n\n是否立即测试回复？')){
        const text=prompt('回复内容：','这是管理后台的测试回复。');
        if(text)await api('/reply',{userId:id,messageRef:first.messageRef,text:text});
      }
    }
    await loadUsers();await loadMessages();
  }catch(e){alert(e.message);}
}

function kindLabel(k){return ({text:'文本',image:'图片',voice:'语音',file:'文件',video:'视频',mixed:'混合',unknown:'未知'})[k]||k;}
function directionLabel(d){return d==='inbound'?'微信 → ChatGPT':'ChatGPT → 微信';}
async function loadMessages(){
  const el=document.getElementById('messages');
  try{
    const data=await api('/messages?limit=200');
    const rows=data.messages||[];
    if(!rows.length){el.innerHTML='<div class="muted">暂无消息记录。</div>';return;}
    el.innerHTML=rows.map(function(m){
      const meta=m.metadata&&Object.keys(m.metadata).length?'<details><summary class="muted">多模态/技术元数据</summary><pre>'+esc(JSON.stringify(m.metadata,null,2))+'</pre></details>':'';
      return '<div class="message">'+
        '<div class="between"><div class="meta"><span>'+esc(m.user.name)+' ('+esc(m.user.id)+')</span><span>'+directionLabel(m.direction)+'</span><span>'+kindLabel(m.kind)+'</span><span>'+esc(m.status)+'</span><span>'+esc(m.createdAt)+'</span></div>'+
        '<button class="small danger" onclick="deleteMessage(\''+esc(m.messageRef)+'\')">删除</button></div>'+
        '<div class="message-text">'+esc(m.text||'')+'</div>'+meta+
      '</div>';
    }).join('');
  }catch(e){el.innerHTML='<div class="warn">错误：'+esc(e.message)+'</div>';}
}
async function deleteMessage(ref){if(!confirm('确定删除这条消息记录？'))return;try{await api('/messages/delete',{messageRef:ref});await loadMessages();await loadUsers();}catch(e){alert(e.message);}}

loadUsers(); loadMessages();
</script>
</body>
</html>`;
