export const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="color-scheme" content="light" />
  <title>微信 MCP 管理</title>
  <style>
    :root{
      --pg-primary:#1677FF;--pg-primary-soft:#EAF3FF;--pg-bg:#F5F7FA;--pg-card:#FFFFFF;
      --pg-text:#1F2937;--pg-secondary:#6B7280;--pg-border:#E5E7EB;--pg-success:#52C41A;
      --pg-warning:#FAAD14;--pg-danger:#FF4D4F;--pg-radius:12px;--pg-control:44px;
      --sidebar:228px;--sidebar-collapsed:76px;--mobile-nav:64px;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    }
    *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--pg-bg);color:var(--pg-text)}
    button,input,textarea,select{font:inherit}button{touch-action:manipulation}
    .shell{min-height:100vh}.sider{position:fixed;inset:0 auto 0 0;width:var(--sidebar);z-index:30;background:#fff;border-right:1px solid var(--pg-border)}
    .brand{height:64px;display:flex;align-items:center;gap:10px;padding:0 20px;font-size:17px;font-weight:700;white-space:nowrap;overflow:hidden}
    .brandMark{display:grid;place-items:center;width:34px;height:34px;flex:0 0 34px;border-radius:10px;background:var(--pg-primary);color:#fff}
    .brandMark svg{width:20px;height:20px}.nav{padding:8px}.navBtn{width:100%;height:44px;border:0;background:transparent;border-radius:8px;display:flex;align-items:center;gap:12px;padding:0 12px;color:#4B5563;cursor:pointer;text-align:left;margin:2px 0}
    .navBtn svg{width:19px;height:19px;flex:0 0 19px}.navBtn:hover{background:#F3F6FA}.navBtn.active{background:var(--pg-primary-soft);color:var(--pg-primary);font-weight:600}
    .body{width:calc(100% - var(--sidebar));margin-left:var(--sidebar)}.desktopTop{height:64px;padding:0 28px;display:flex;align-items:center;justify-content:space-between;background:#fff;border-bottom:1px solid var(--pg-border);position:sticky;top:0;z-index:20}
    .topStatus{display:flex;align-items:center;gap:9px;font-size:14px}.dot{width:8px;height:8px;border-radius:50%;background:var(--pg-success)}.adminIdentity{display:flex;align-items:center;gap:9px;color:var(--pg-secondary);font-size:14px}.avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:#EEF2F7;color:#526071;font-weight:700}
    .mobileTop{display:none}.content{padding:24px 28px 48px;max-width:1440px;margin:0 auto}.section{display:none}.section.active{display:block}
    .pageTitle{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.pageTitle h1{font-size:24px;line-height:1.3;margin:0 0 5px}.subtitle{color:var(--pg-secondary);font-size:14px;line-height:1.55;margin:0}
    .btn{min-height:var(--pg-control);border:1px solid var(--pg-border);border-radius:8px;padding:0 15px;background:#fff;color:var(--pg-text);cursor:pointer;font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:7px}
    .btn:hover{border-color:#B8C7DB}.btn.primary{border-color:var(--pg-primary);background:var(--pg-primary);color:#fff}.btn.danger{border-color:#FFCCC7;color:#CF1322;background:#FFF2F0}.btn.ghost{background:transparent}.btn.small{min-height:34px;padding:0 10px;font-size:13px}.btn:disabled{opacity:.45;cursor:not-allowed}
    .statGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}.card{background:#fff;border:1px solid var(--pg-border);border-radius:var(--pg-radius);padding:18px}.statLabel{color:var(--pg-secondary);font-size:13px}.statValue{font-size:28px;font-weight:700;line-height:1.25;margin-top:8px}.statHint{color:var(--pg-secondary);font-size:12px;margin-top:5px}
    .grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.cardTitle{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}.cardTitle h2{font-size:17px;margin:0}.cardTitle h3{font-size:15px;margin:0}.muted{color:var(--pg-secondary);font-size:13px}.statusLine{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .tag{display:inline-flex;align-items:center;min-height:25px;padding:0 9px;border-radius:999px;background:#F3F4F6;color:#5A6472;font-size:12px;white-space:nowrap}.tag.ok{background:#F0F9EB;color:#389E0D}.tag.warn{background:#FFF7E6;color:#D46B08}.tag.blue{background:#EAF3FF;color:#1677FF}.tag.off{background:#F3F4F6;color:#8A94A3}.tag.danger{background:#FFF2F0;color:#CF1322}
    .userGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.userCard{background:#fff;border:1px solid var(--pg-border);border-radius:var(--pg-radius);padding:17px}.userHead{display:flex;justify-content:space-between;gap:10px;margin-bottom:12px}.userName{font-size:17px;font-weight:650}.userId{font-size:12px;color:var(--pg-secondary);margin-top:3px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}.detailGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;border-top:1px solid var(--pg-border);margin-top:14px;padding-top:12px}.detailItem span{display:block}.detailKey{font-size:12px;color:var(--pg-secondary)}.detailValue{font-size:13px;margin-top:3px;overflow-wrap:anywhere}
    .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.toolbar .grow{flex:1}.input,.select,.textarea{width:100%;min-height:var(--pg-control);border:1px solid #D9E0E8;border-radius:8px;background:#fff;color:var(--pg-text);padding:9px 11px;outline:none}.input:focus,.select:focus,.textarea:focus{border-color:var(--pg-primary);box-shadow:0 0 0 2px rgba(22,119,255,.1)}.textarea{min-height:96px;resize:vertical}.field label{display:block;font-size:13px;color:#4B5563;margin-bottom:6px}.formGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
    .messageList{background:#fff;border:1px solid var(--pg-border);border-radius:var(--pg-radius);overflow:hidden}.message{padding:15px 17px;border-top:1px solid var(--pg-border)}.message:first-child{border-top:0}.messageHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.messageMeta{display:flex;gap:7px;flex-wrap:wrap;align-items:center}.messageText{white-space:pre-wrap;word-break:break-word;line-height:1.62;margin-top:10px;font-size:14px}.tech{margin-top:10px}.tech summary{cursor:pointer;color:var(--pg-secondary);font-size:12px}.tech pre{white-space:pre-wrap;word-break:break-word;background:#F7F8FA;border:1px solid var(--pg-border);border-radius:8px;padding:10px;font-size:12px;overflow:auto;max-height:220px}
    .empty{padding:34px 20px;text-align:center;color:var(--pg-secondary)}.notice{border:1px solid #BAE0FF;background:#F0F8FF;border-radius:10px;padding:12px 14px;color:#38536B;font-size:13px;line-height:1.6}.warningNotice{border-color:#FFE58F;background:#FFFBE6;color:#7A5A15}.dangerNotice{border-color:#FFCCC7;background:#FFF2F0;color:#8C2B25}
    .settingsList{display:grid;gap:12px}.settingRow{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:15px 0;border-top:1px solid var(--pg-border)}.settingRow:first-child{border-top:0;padding-top:0}.settingRow:last-child{padding-bottom:0}.settingLabel{font-weight:600;font-size:14px}.settingValue{color:var(--pg-secondary);font-size:13px;margin-top:4px;line-height:1.5;word-break:break-all;text-align:right}
    .bottom{display:none}.modalBackdrop{position:fixed;inset:0;background:rgba(15,23,42,.38);z-index:80;display:none;align-items:center;justify-content:center;padding:18px}.modalBackdrop.open{display:flex}.modal{width:min(560px,100%);max-height:min(780px,calc(100vh - 36px));overflow:auto;background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(15,23,42,.22)}.modalHead{padding:17px 20px;border-bottom:1px solid var(--pg-border);display:flex;align-items:center;justify-content:space-between}.modalHead h2{font-size:18px;margin:0}.modalBody{padding:18px 20px}.modalFoot{padding:13px 20px;border-top:1px solid var(--pg-border);display:flex;justify-content:flex-end;gap:9px}.iconBtn{width:40px;height:40px;border:0;border-radius:8px;background:transparent;cursor:pointer;font-size:22px;color:#6B7280}
    #qr{text-align:center;margin:14px 0}#qr svg{width:min(72vw,300px);height:auto;background:#fff;padding:8px;border-radius:10px}.bindInfo{text-align:center;color:var(--pg-secondary);font-size:13px;line-height:1.55}.debugBox{white-space:pre-wrap;word-break:break-word;background:#F7F8FA;border:1px solid var(--pg-border);border-radius:8px;padding:10px;font-size:12px;max-height:220px;overflow:auto}
    @media(max-width:1100px){.statGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.grid2{grid-template-columns:1fr}}
    @media(max-width:991px){.sider{width:var(--sidebar-collapsed)}.brand{padding:0 21px}.brandText,.navLabel{display:none}.navBtn{justify-content:center;padding:0}.body{width:calc(100% - var(--sidebar-collapsed));margin-left:var(--sidebar-collapsed)}.content{padding:20px}.userGrid{grid-template-columns:1fr}}
    @media(max-width:767px){.sider,.desktopTop{display:none}.body{width:100%;margin:0}.mobileTop{min-height:56px;display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:#fff;border-bottom:1px solid var(--pg-border);position:sticky;top:0;z-index:30}.mobileTitle{display:flex;align-items:center;gap:9px;font-size:16px}.content{padding:16px 12px calc(var(--mobile-nav) + env(safe-area-inset-bottom) + 26px)}.bottom{position:fixed;display:grid;grid-template-columns:repeat(4,1fr);left:0;right:0;bottom:0;z-index:60;padding:5px 2px calc(5px + env(safe-area-inset-bottom));background:#fff;border-top:1px solid var(--pg-border)}.bottom button{min-height:52px;border:0;background:transparent;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:3px;color:var(--pg-secondary);font-size:11px}.bottom svg{width:19px;height:19px}.bottom button.active{color:var(--pg-primary);font-weight:600}.pageTitle{align-items:center}.pageTitle h1{font-size:21px}.pageTitle .subtitle{display:none}.statGrid{gap:10px}.card{padding:15px}.statValue{font-size:24px}.formGrid{grid-template-columns:1fr}.userGrid{grid-template-columns:1fr}.message{padding:14px}.messageHead{display:block}.messageHead>.btn{margin-top:9px}.settingRow{display:block}.settingValue{text-align:left;margin-top:6px}.modalBackdrop{padding:0;align-items:flex-end}.modal{width:100%;max-height:88vh;border-radius:16px 16px 0 0}.actions .btn{flex:1 1 auto}}
    @media(max-width:420px){.statGrid{grid-template-columns:1fr 1fr}.statHint{display:none}.pageTitle .btn span{display:none}}
  </style>
</head>
<body>
<div class="shell">
  <aside class="sider">
    <div class="brand"><span class="brandMark">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z"/><path d="M8.5 12l2.2 2.2 4.8-5"/></svg>'}</span><span class="brandText">微信 MCP</span></div>
    <nav class="nav">
      <button class="navBtn active" data-section="overview" onclick="switchSection('overview',this)">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'}<span class="navLabel">概览</span></button>
      <button class="navBtn" data-section="users" onclick="switchSection('users',this)">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M2.5 21a6.5 6.5 0 0113 0"/><path d="M16 5.5a3.5 3.5 0 010 7"/><path d="M17 15a5 5 0 014.5 5"/></svg>'}<span class="navLabel">微信用户</span></button>
      <button class="navBtn" data-section="messages" onclick="switchSection('messages',this)">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v13H8l-4 4V4z"/><path d="M8 9h8M8 13h5"/></svg>'}<span class="navLabel">消息记录</span></button>
      <button class="navBtn" data-section="settings" onclick="switchSection('settings',this)">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.6V21h-4v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 00.3-1.9A1.7 1.7 0 003 14H3v-4h.1a1.7 1.7 0 001.6-1 1.7 1.7 0 00-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 001.9.3A1.7 1.7 0 0010 3V3h4v.1a1.7 1.7 0 001 1.6 1.7 1.7 0 001.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 00-.3 1.9 1.7 1.7 0 001.6 1H21v4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>'}<span class="navLabel">设置</span></button>
    </nav>
  </aside>

  <div class="body">
    <header class="desktopTop"><div class="topStatus"><span class="dot"></span><span id="desktopStatus">服务运行中</span></div><div class="adminIdentity"><span class="avatar">管</span><span>管理员</span></div></header>
    <header class="mobileTop"><div class="mobileTitle"><span class="brandMark" style="width:32px;height:32px;flex-basis:32px">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z"/><path d="M8.5 12l2.2 2.2 4.8-5"/></svg>'}</span><strong id="mobileSectionTitle">微信 MCP</strong></div><span class="tag ok" id="mobileStatus">运行中</span></header>

    <main class="content">
      <section id="section-overview" class="section active">
        <div class="pageTitle"><div><h1>概览</h1><p class="subtitle">微信 ClawBot Remote MCP 的运行状态、用户与消息概况。</p></div><button class="btn" onclick="refreshAll()">刷新</button></div>
        <div class="statGrid">
          <div class="card"><div class="statLabel">微信用户</div><div class="statValue" id="statUsers">-</div><div class="statHint">已配置收信用户</div></div>
          <div class="card"><div class="statLabel">已绑定</div><div class="statValue" id="statConnected">-</div><div class="statHint">ClawBot 可用通道</div></div>
          <div class="card"><div class="statLabel">待处理</div><div class="statValue" id="statPending">-</div><div class="statHint">等待 ChatGPT 轮询</div></div>
          <div class="card"><div class="statLabel">消息记录</div><div class="statValue" id="statMessages">-</div><div class="statHint">Cloudflare DO SQLite</div></div>
        </div>
        <div class="grid2">
          <div class="card"><div class="cardTitle"><h2>通道状态</h2><span class="tag blue">v0.3</span></div><div id="overviewUsers" class="muted">正在读取...</div></div>
          <div class="card"><div class="cardTitle"><h2>存储策略</h2></div><div class="notice">文本、状态、cursor、context token 和消息历史保存在 SQLite-backed Durable Object。多媒体二进制不会塞进单个 2 MB 行；后续采用分片 BLOB 存储，不要求 R2。</div><div class="warningNotice" style="margin-top:10px">免费版单个 Durable Object 最大 1 GB、整个账户 DO SQL 存储总计 5 GB。会预留安全空间并在达到软阈值/写满时通过 ClawBot 提醒管理员。</div></div>
        </div>
      </section>

      <section id="section-users" class="section">
        <div class="pageTitle"><div><h1>微信用户</h1><p class="subtitle">维护可供 ChatGPT 选择的收信用户，并分别扫码绑定各自 ClawBot。</p></div><button class="btn primary" onclick="openAddModal()"><span>添加用户</span>＋</button></div>
        <div id="users" class="userGrid"><div class="card muted">正在读取...</div></div>
      </section>

      <section id="section-messages" class="section">
        <div class="pageTitle"><div><h1>消息记录</h1><p class="subtitle">统一查看微信入站、ChatGPT 主动发送和回复记录。</p></div><button class="btn" onclick="loadMessages()">刷新</button></div>
        <div class="toolbar">
          <select id="filterUser" class="select" style="width:auto;min-width:150px" onchange="renderMessages()"><option value="">全部用户</option></select>
          <select id="filterDirection" class="select" style="width:auto;min-width:140px" onchange="renderMessages()"><option value="">全部方向</option><option value="inbound">微信 → ChatGPT</option><option value="outbound">ChatGPT → 微信</option></select>
          <select id="filterKind" class="select" style="width:auto;min-width:120px" onchange="renderMessages()"><option value="">全部类型</option><option value="text">文本</option><option value="image">图片</option><option value="voice">语音</option><option value="file">文件</option><option value="video">视频</option><option value="mixed">混合</option></select>
          <input id="filterText" class="input grow" style="min-width:180px" placeholder="搜索消息内容" oninput="renderMessages()" />
        </div>
        <div id="messages" class="messageList"><div class="empty">正在读取...</div></div>
      </section>

      <section id="section-settings" class="section">
        <div class="pageTitle"><div><h1>设置</h1><p class="subtitle">服务地址、存储边界与联调工具。</p></div></div>
        <div class="grid2">
          <div class="card"><div class="cardTitle"><h2>服务端点</h2></div><div class="settingsList">
            <div class="settingRow"><div><div class="settingLabel">Remote MCP</div><div class="muted">ChatGPT 连接地址</div></div><div class="settingValue" id="mcpUrl"></div></div>
            <div class="settingRow"><div><div class="settingLabel">管理后台</div><div class="muted">当前页面</div></div><div class="settingValue" id="adminUrl"></div></div>
            <div class="settingRow"><div><div class="settingLabel">兼容入口</div></div><div class="settingValue">/setup → /admin</div></div>
          </div></div>
          <div class="card"><div class="cardTitle"><h2>媒体存储边界</h2></div><div class="notice">不使用 R2。二进制媒体采用 SQLite 分片方案：每片控制在 1 MB 左右，以避开 Cloudflare SQL 单行/BLOB 2 MB 上限。媒体达到项目设置的软容量后停止继续保存大文件，但仍保留消息元数据。</div><div class="dangerNotice" style="margin-top:10px">如果 SQLite 写入返回 SQLITE_FULL，Worker 会继续允许读取和删除，并尝试通过已经绑定的 ClawBot 发送“存储已满，请清理”的告警消息。</div></div>
        </div>
      </section>
    </main>
  </div>

  <nav class="bottom" aria-label="移动端主导航">
    <button class="active" data-section="overview" onclick="switchSection('overview',this)">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'}<span>概览</span></button>
    <button data-section="users" onclick="switchSection('users',this)">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M2.5 21a6.5 6.5 0 0113 0"/><path d="M16 5.5a3.5 3.5 0 010 7"/></svg>'}<span>用户</span></button>
    <button data-section="messages" onclick="switchSection('messages',this)">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v13H8l-4 4V4z"/><path d="M8 9h8M8 13h5"/></svg>'}<span>消息</span></button>
    <button data-section="settings" onclick="switchSection('settings',this)">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 01-.2 1.7l2 1.5-2 3.4-2.4-1a7 7 0 01-2.9 1.7L13.2 22h-4l-.3-2.7A7 7 0 016 17.6l-2.4 1-2-3.4 2-1.5A7 7 0 013.4 12c0-.6.1-1.2.2-1.7l-2-1.5 2-3.4 2.4 1A7 7 0 018.9 4.7L9.2 2h4l.3 2.7A7 7 0 0116.4 6.4l2.4-1 2 3.4-2 1.5c.1.5.2 1.1.2 1.7z"/></svg>'}<span>设置</span></button>
  </nav>
</div>

<div id="addModal" class="modalBackdrop" onclick="backdropClose(event,'addModal')"><div class="modal">
  <div class="modalHead"><h2>添加微信用户</h2><button class="iconBtn" onclick="closeModal('addModal')">×</button></div>
  <div class="modalBody"><div class="formGrid"><div class="field"><label>用户标识</label><input id="newId" class="input" placeholder="例如 zhenhua / wife" /></div><div class="field"><label>显示名称</label><input id="newName" class="input" placeholder="例如 振华 / 老婆" /></div></div><p class="muted">用户标识给 ChatGPT 的 recipients 参数使用；创建后建议不要修改标识，只修改显示名称。</p><div id="addResult" class="muted"></div></div>
  <div class="modalFoot"><button class="btn" onclick="closeModal('addModal')">取消</button><button class="btn primary" onclick="addUser()">添加</button></div>
</div></div>

<div id="bindModal" class="modalBackdrop" onclick="backdropClose(event,'bindModal')"><div class="modal">
  <div class="modalHead"><h2>扫码绑定 ClawBot</h2><button class="iconBtn" onclick="closeModal('bindModal')">×</button></div>
  <div class="modalBody"><div id="bindTitle" class="bindInfo"></div><div id="qr"></div><div id="loginMessage" class="bindInfo"></div><div id="verifyBox" style="display:none;margin-top:14px"><div class="field"><label>微信显示的配对数字</label><input id="verifyCode" class="input" inputmode="numeric" placeholder="输入配对数字" /></div><button class="btn primary" onclick="submitVerifyCode()">提交配对码</button></div></div>
  <div class="modalFoot"><button class="btn" onclick="closeModal('bindModal')">关闭</button></div>
</div></div>

<script>
let currentUserId=null,currentSession=null,loginPolling=false;
let cachedUsers=[],cachedMessages=[];
const sectionTitles={overview:'微信 MCP',users:'微信用户',messages:'消息记录',settings:'设置'};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function api(path,body){const options=body===undefined?{method:'GET'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})};const res=await fetch('/admin/api'+path,options);const data=await res.json().catch(()=>({message:'返回内容不是 JSON'}));if(!res.ok)throw new Error(data.message||data.error||('HTTP '+res.status));return data;}
function switchSection(id,source){document.querySelectorAll('.section').forEach(x=>x.classList.remove('active'));document.getElementById('section-'+id).classList.add('active');document.querySelectorAll('[data-section]').forEach(x=>x.classList.toggle('active',x.dataset.section===id));document.getElementById('mobileSectionTitle').textContent=sectionTitles[id]||'微信 MCP';if(id==='messages')loadMessages();if(id==='users')loadUsers();window.scrollTo({top:0,behavior:'instant'});}
function openModal(id){document.getElementById(id).classList.add('open');document.body.style.overflow='hidden';}function closeModal(id){document.getElementById(id).classList.remove('open');document.body.style.overflow='';}function backdropClose(e,id){if(e.target.id===id)closeModal(id)}
function openAddModal(){document.getElementById('newId').value='';document.getElementById('newName').value='';document.getElementById('addResult').textContent='';openModal('addModal');}
function statusTag(u){const s=u.status||{};if(!u.enabled)return '<span class="tag off">已停用</span>';return s.connected?'<span class="tag ok">已绑定</span>':'<span class="tag warn">未绑定</span>';}
function fmtTime(v){if(!v)return '—';try{return new Date(v).toLocaleString('zh-CN',{hour12:false});}catch{return v}}
function kindLabel(k){return ({text:'文本',image:'图片',voice:'语音',file:'文件',video:'视频',mixed:'混合',unknown:'未知'})[k]||k||'未知';}
function directionLabel(d){return d==='inbound'?'微信 → ChatGPT':'ChatGPT → 微信';}

async function loadUsers(){
  const el=document.getElementById('users');
  try{
    const data=await api('/users');cachedUsers=data.users||[];
    if(!cachedUsers.length){el.innerHTML='<div class="card empty">还没有微信用户。点击“添加用户”，创建后再扫码绑定。</div>';updateOverview();updateUserFilter();return;}
    el.innerHTML=cachedUsers.map(u=>{const s=u.status||{};return '<article class="userCard"><div class="userHead"><div><div class="userName">'+esc(u.name)+'</div><div class="userId">'+esc(u.id)+'</div></div><div class="statusLine">'+statusTag(u)+(u.isDefault?' <span class="tag blue">默认</span>':'')+'</div></div><div class="detailGrid"><div class="detailItem"><span class="detailKey">待处理消息</span><span class="detailValue">'+Number(s.pendingInbound||0)+'</span></div><div class="detailItem"><span class="detailKey">历史消息</span><span class="detailValue">'+Number(s.messageCount||0)+'</span></div><div class="detailItem"><span class="detailKey">最近轮询</span><span class="detailValue">'+esc(fmtTime(s.lastPollAt))+'</span></div><div class="detailItem"><span class="detailKey">最近错误</span><span class="detailValue">'+esc(s.lastPollError||'—')+'</span></div></div><div class="actions"><button class="btn small primary" onclick="startBind(\''+esc(u.id)+'\',\''+esc(u.name)+'\')">'+(s.connected?'重新绑定':'扫码绑定')+'</button><button class="btn small" onclick="editUser(\''+esc(u.id)+'\')">编辑</button><button class="btn small" onclick="testSend(\''+esc(u.id)+'\')">测试发送</button><button class="btn small" onclick="testPoll(\''+esc(u.id)+'\')">拉取回复</button><button class="btn small danger" onclick="deleteUser(\''+esc(u.id)+'\',\''+esc(u.name)+'\')">删除</button></div></article>';}).join('');
    updateOverview();updateUserFilter();
  }catch(e){el.innerHTML='<div class="card dangerNotice">读取用户失败：'+esc(e.message)+'</div>';}
}
function updateOverview(){const connected=cachedUsers.filter(u=>u.status&&u.status.connected).length;const pending=cachedUsers.reduce((n,u)=>n+Number(u.status&&u.status.pendingInbound||0),0);const records=cachedUsers.reduce((n,u)=>n+Number(u.status&&u.status.messageCount||0),0);document.getElementById('statUsers').textContent=cachedUsers.length;document.getElementById('statConnected').textContent=connected;document.getElementById('statPending').textContent=pending;document.getElementById('statMessages').textContent=records;const list=document.getElementById('overviewUsers');if(!cachedUsers.length){list.innerHTML='<div class="empty">尚未添加微信用户</div>';return;}list.innerHTML=cachedUsers.map(u=>'<div class="settingRow"><div><div class="settingLabel">'+esc(u.name)+'</div><div class="muted">'+esc(u.id)+'</div></div><div>'+statusTag(u)+(u.isDefault?' <span class="tag blue">默认</span>':'')+'</div></div>').join('');}
function updateUserFilter(){const sel=document.getElementById('filterUser');const current=sel.value;sel.innerHTML='<option value="">全部用户</option>'+cachedUsers.map(u=>'<option value="'+esc(u.id)+'">'+esc(u.name)+'</option>').join('');sel.value=current;}
async function refreshAll(){await loadUsers();await loadMessages();}
async function addUser(){const id=document.getElementById('newId').value.trim(),name=document.getElementById('newName').value.trim();try{const data=await api('/users/create',{id,name});document.getElementById('addResult').textContent='已添加 '+data.user.name;await loadUsers();closeModal('addModal');switchSection('users');}catch(e){document.getElementById('addResult').textContent='错误：'+e.message;}}
async function editUser(id){const u=cachedUsers.find(x=>x.id===id);if(!u)return;const name=prompt('显示名称：',u.name);if(name===null)return;try{await api('/users/update',{id,name});if(confirm('是否将此用户设为默认收信人？\n选择“取消”只修改名称。'))await api('/users/update',{id,isDefault:true});await loadUsers();}catch(e){alert(e.message);}}
async function toggleUser(id,enabled){try{await api('/users/update',{id,enabled});await loadUsers();}catch(e){alert(e.message);}}
async function deleteUser(id,name){if(!confirm('删除“'+name+'”会清除该用户的本地绑定凭证、cursor 和消息历史。确定删除？'))return;try{await api('/users/delete',{id});await refreshAll();}catch(e){alert(e.message);}}
async function clearMessages(id){if(!confirm('确定清空 '+id+' 的全部消息历史？绑定关系不会删除。'))return;try{await api('/messages/clear',{userId:id});await refreshAll();}catch(e){alert(e.message);}}

async function startBind(id,name){currentUserId=id;currentSession=null;openModal('bindModal');document.getElementById('bindTitle').textContent='正在为 '+name+'（'+id+'）生成二维码';document.getElementById('qr').innerHTML='';document.getElementById('verifyBox').style.display='none';try{const data=await api('/login/start',{userId:id});currentSession=data.sessionId;document.getElementById('qr').innerHTML=data.qrSvg||'';document.getElementById('loginMessage').textContent='请用对应微信扫描二维码并确认。';pollLogin();}catch(e){document.getElementById('loginMessage').textContent='错误：'+e.message;}}
async function pollLogin(verifyCode){if(!currentUserId||!currentSession||loginPolling)return;loginPolling=true;try{const data=await api('/login/status',{userId:currentUserId,sessionId:currentSession,verifyCode});document.getElementById('loginMessage').textContent=data.message||data.status||'';if(data.needsVerifyCode){document.getElementById('verifyBox').style.display='block';return;}document.getElementById('verifyBox').style.display='none';if(data.connected){document.getElementById('qr').innerHTML='<span class="tag ok">绑定成功</span>';currentSession=null;await loadUsers();return;}if(data.status==='expired'||data.status==='verify_code_blocked')return;}catch(e){document.getElementById('loginMessage').textContent='轮询错误：'+e.message;}finally{loginPolling=false;}if(currentSession)setTimeout(()=>pollLogin(),1200);}
async function submitVerifyCode(){const code=document.getElementById('verifyCode').value.trim();if(!code)return;document.getElementById('verifyBox').style.display='none';await pollLogin(code);}
async function testSend(id){const text=prompt('发送测试内容：','weixin-mcp-worker 测试消息：如果你看到这条消息，说明发送链路已打通。');if(text===null)return;try{const data=await api('/send',{userId:id,text});alert(JSON.stringify(data,null,2));await refreshAll();}catch(e){alert(e.message);}}
async function testPoll(id){try{const data=await api('/poll',{userId:id,limit:20});if(!data.messages||!data.messages.length){alert('没有拉到待处理消息。');await loadUsers();return;}const first=data.messages[0];if(confirm('拉到待处理消息：\n\n'+first.text+'\n\n是否立即测试回复？')){const text=prompt('回复内容：','这是管理后台的测试回复。');if(text)await api('/reply',{userId:id,messageRef:first.messageRef,text});}await refreshAll();}catch(e){alert(e.message);}}

async function loadMessages(){const el=document.getElementById('messages');try{const data=await api('/messages?limit=500');cachedMessages=data.messages||[];renderMessages();}catch(e){el.innerHTML='<div class="empty">读取消息失败：'+esc(e.message)+'</div>';}}
function renderMessages(){const el=document.getElementById('messages'),uid=document.getElementById('filterUser').value,dir=document.getElementById('filterDirection').value,kind=document.getElementById('filterKind').value,q=document.getElementById('filterText').value.trim().toLowerCase();const rows=cachedMessages.filter(m=>(!uid||m.user.id===uid)&&(!dir||m.direction===dir)&&(!kind||m.kind===kind)&&(!q||String(m.text||'').toLowerCase().includes(q)));if(!rows.length){el.innerHTML='<div class="empty">暂无符合条件的消息记录。</div>';return;}el.innerHTML=rows.map(m=>{const meta=m.metadata&&Object.keys(m.metadata).length?'<details class="tech"><summary>多模态 / 技术元数据</summary><pre>'+esc(JSON.stringify(m.metadata,null,2))+'</pre></details>':'';return '<article class="message"><div class="messageHead"><div class="messageMeta"><span class="tag blue">'+esc(m.user.name)+'</span><span class="tag">'+esc(directionLabel(m.direction))+'</span><span class="tag">'+esc(kindLabel(m.kind))+'</span><span class="tag '+(m.status==='failed'?'danger':m.status==='pending'?'warn':'ok')+'">'+esc(m.status)+'</span><span class="muted">'+esc(fmtTime(m.createdAt))+'</span></div><button class="btn small danger" onclick="deleteMessage(\''+esc(m.messageRef)+'\')">删除</button></div><div class="messageText">'+esc(m.text||'')+'</div>'+meta+'</article>';}).join('');}
async function deleteMessage(ref){if(!confirm('确定删除这条消息记录？'))return;try{await api('/messages/delete',{messageRef:ref});await refreshAll();}catch(e){alert(e.message);}}

document.getElementById('mcpUrl').textContent=location.origin+'/mcp';document.getElementById('adminUrl').textContent=location.origin+'/admin';loadUsers();loadMessages();
</script>
</body>
</html>`;
