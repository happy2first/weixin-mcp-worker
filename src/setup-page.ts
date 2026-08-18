export const SETUP_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Weixin MCP Worker</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    body { margin: 0; background: #f5f6f8; color: #111; }
    main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
    .card { background: white; border-radius: 16px; padding: 20px; margin: 14px 0; box-shadow: 0 1px 8px rgba(0,0,0,.06); }
    h1 { font-size: 24px; margin: 0 0 6px; }
    h2 { font-size: 18px; margin: 0 0 12px; }
    p { line-height: 1.55; }
    button { border: 0; border-radius: 10px; padding: 11px 15px; margin: 4px 8px 4px 0; font-size: 15px; cursor: pointer; background: #111; color: white; }
    button.secondary { background: #e9eaed; color: #111; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 11px; border: 1px solid #d7d9dd; border-radius: 9px; font-size: 16px; margin: 6px 0 10px; font-family: inherit; }
    textarea { min-height: 92px; resize: vertical; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f2f3f5; border-radius: 10px; padding: 12px; font-size: 13px; }
    #qr svg { width: min(78vw, 320px); height: auto; background: white; padding: 10px; border-radius: 10px; }
    .ok { color: #15803d; font-weight: 600; }
    .warn { color: #b45309; font-weight: 600; }
    .muted { color: #666; font-size: 14px; }
    @media (prefers-color-scheme: dark) {
      body { background: #111318; color: #f3f4f6; }
      .card { background: #1b1e24; }
      input, textarea { background: #111318; border-color: #3b3f46; color: white; }
      pre { background: #111318; }
      button.secondary { background: #353941; color: white; }
      .muted { color: #aeb3bd; }
    }
  </style>
</head>
<body>
<main>
  <h1>微信 ClawBot MCP</h1>
  <p class="muted">v0.2：支持 ChatGPT → 微信主动发送，以及由 ChatGPT 定时调用 weixin_poll 实现的小时级异步收取/回复。凭证、cursor 和 context_token 只保存在 Cloudflare Durable Object 中。</p>

  <section class="card">
    <h2>1. 当前状态</h2>
    <button onclick="refreshStatus()">刷新状态</button>
    <pre id="status">正在读取...</pre>
  </section>

  <section class="card">
    <h2>2. 扫码绑定</h2>
    <p>点击生成二维码后，用微信扫描并确认。若微信要求输入配对数字，本页会提示。</p>
    <button onclick="startLogin()">生成新的二维码</button>
    <div id="qr" style="margin-top:16px"></div>
    <div id="loginMessage" class="muted"></div>
    <div id="verifyBox" style="display:none;margin-top:12px">
      <label>微信显示的配对数字</label>
      <input id="verifyCode" inputmode="numeric" placeholder="请输入配对数字" />
      <button onclick="submitVerifyCode()">提交配对数字</button>
    </div>
  </section>

  <section class="card">
    <h2>3. 测试主动发送</h2>
    <input id="testText" value="weixin-mcp-worker 测试消息：如果你看到这条消息，说明 Worker → 微信链路已经打通。" />
    <button onclick="testSend()">发到我的微信</button>
    <pre id="sendResult">尚未测试</pre>
  </section>

  <section class="card">
    <h2>4. 测试收取与回复</h2>
    <p class="muted">先在微信 ClawBot 中回复一条消息，然后点“拉取微信回复”。这相当于以后 ChatGPT 每小时调用一次 weixin_poll。</p>
    <button onclick="pollInbound()">拉取微信回复</button>
    <pre id="pollResult">尚未拉取</pre>
    <label>messageRef</label>
    <input id="replyRef" placeholder="拉取成功后会自动填入第一条待处理消息的 messageRef" />
    <label>测试回复内容</label>
    <textarea id="replyText">这是 weixin_reply 的测试回复。如果你在微信看到这条消息，说明 微信 → Worker → 回复微信 的链路已经打通。</textarea>
    <button onclick="replyInbound()">回复这条微信</button>
    <pre id="replyResult">尚未回复</pre>
  </section>
</main>
<script>
let currentSession = null;
let polling = false;

async function api(path, body) {
  const options = body === undefined ? { method: 'GET' } : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  };
  const res = await fetch('/admin/api' + path, options);
  const data = await res.json().catch(() => ({ message: '返回内容不是 JSON' }));
  if (!res.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status));
  return data;
}

function show(id, value) {
  document.getElementById(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function refreshStatus() {
  try { show('status', await api('/status')); }
  catch (e) { show('status', '错误：' + e.message); }
}

async function startLogin() {
  try {
    document.getElementById('verifyBox').style.display = 'none';
    document.getElementById('loginMessage').textContent = '正在生成二维码...';
    const data = await api('/login/start', {});
    currentSession = data.sessionId;
    document.getElementById('qr').innerHTML = data.qrSvg || '';
    document.getElementById('loginMessage').textContent = '请用微信扫码并确认。二维码约 5 分钟有效。';
    pollLogin();
  } catch (e) {
    document.getElementById('loginMessage').textContent = '错误：' + e.message;
  }
}

async function pollLogin(verifyCode) {
  if (!currentSession || polling) return;
  polling = true;
  try {
    const data = await api('/login/status', { sessionId: currentSession, verifyCode });
    document.getElementById('loginMessage').textContent = data.message || data.status || '';
    if (data.needsVerifyCode) {
      document.getElementById('verifyBox').style.display = 'block';
      return;
    }
    document.getElementById('verifyBox').style.display = 'none';
    if (data.connected) {
      document.getElementById('qr').innerHTML = '<p class="ok">绑定成功</p>';
      currentSession = null;
      await refreshStatus();
      return;
    }
    if (data.status === 'expired' || data.status === 'verify_code_blocked') return;
  } catch (e) {
    document.getElementById('loginMessage').textContent = '轮询错误：' + e.message;
  } finally {
    polling = false;
  }
  if (currentSession) setTimeout(() => pollLogin(), 1200);
}

async function submitVerifyCode() {
  const code = document.getElementById('verifyCode').value.trim();
  if (!code) return;
  document.getElementById('verifyBox').style.display = 'none';
  await pollLogin(code);
  if (currentSession) setTimeout(() => pollLogin(), 800);
}

async function testSend() {
  try {
    show('sendResult', '发送中...');
    const text = document.getElementById('testText').value;
    show('sendResult', await api('/send', { text }));
    await refreshStatus();
  } catch (e) { show('sendResult', '错误：' + e.message); }
}

async function pollInbound() {
  try {
    show('pollResult', '拉取中；如果当前没有排队消息，可能等待约 8 秒...');
    const data = await api('/poll', { limit: 20 });
    show('pollResult', data);
    if (data.messages && data.messages.length && data.messages[0].messageRef) {
      document.getElementById('replyRef').value = data.messages[0].messageRef;
    }
    await refreshStatus();
  } catch (e) { show('pollResult', '错误：' + e.message); }
}

async function replyInbound() {
  try {
    const messageRef = document.getElementById('replyRef').value.trim();
    const text = document.getElementById('replyText').value;
    if (!messageRef) throw new Error('请先拉取消息并填写 messageRef');
    show('replyResult', '回复中...');
    show('replyResult', await api('/reply', { messageRef, text }));
    await refreshStatus();
  } catch (e) { show('replyResult', '错误：' + e.message); }
}

refreshStatus();
</script>
</body>
</html>`;
