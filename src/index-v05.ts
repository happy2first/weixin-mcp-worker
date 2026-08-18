import baseWorker from "./index.js";
import type { Env } from "./types.js";
export { WeixinBotDO } from "./weixin-bot-v05.js";

function normalizeProfileId(value: unknown): string {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw new Error(`无效微信用户标识：${id || "(空)"}`);
  return id;
}

function userStub(env: Env, userId: string) {
  return env.WEIXIN_BOT.get(env.WEIXIN_BOT.idFromName(`user:${normalizeProfileId(userId)}`));
}

async function adaptDoResponse(response: Awaited<ReturnType<ReturnType<typeof userStub>["fetch"]>>): Promise<Response> {
  const headers = new Headers();
  response.headers.forEach((value, key) => headers.set(key, value));
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

const RETENTION_CARD = `<div class="card" style="margin-bottom:16px"><div class="cardTitle"><h2>历史数据自动保留</h2><span class="tag blue">自动清理</span></div><div class="notice">默认每个微信用户保留 700 MB 交互历史，可设置 50–700 MB。达到上限后，系统自动删除最旧的已处理消息及其附件，清理至约 90%，完成后再通过 ClawBot 通知。尚未处理的微信消息不会被自动删除。</div><div id="retentionSettings" class="settingsList" style="margin-top:14px"></div></div>`;

const RETENTION_JS = `
function renderRetentionSettings(){var el=document.getElementById('retentionSettings');if(!el)return;if(!state.users.length){el.innerHTML='<div class="empty">添加微信用户后可配置历史数据保留上限。</div>';return}el.innerHTML=state.users.map(function(u){var st=u.status||{};var limit=Math.round(Number(st.historyLimitBytes||700*1024*1024)/1024/1024);var used=Number(st.historyBytes||0);var pct=st.historyLimitBytes?Math.min(100,used/Number(st.historyLimitBytes)*100):0;return'<div class="settingRow"><div style="min-width:0;flex:1"><div class="settingLabel">'+esc(u.name)+' <span class="muted">('+esc(u.id)+')</span></div><div class="settingValue" style="text-align:left">已保留 '+fmtBytes(used)+' · SQLite 文件 '+fmtBytes(st.databaseBytes||0)+(st.retentionLastCleanupAt?' · 最近自动清理 '+esc(fmtTime(st.retentionLastCleanupAt)):'')+'</div><div class="progress" style="margin-top:8px"><div class="progressBar" style="width:'+pct.toFixed(2)+'%"></div></div></div><div style="width:min(280px,100%)"><div style="display:flex;gap:8px"><input id="retention-'+esc(u.id)+'" class="input" type="number" min="50" max="700" step="50" value="'+limit+'" /><button class="btn primary" onclick="saveRetention(\\''+esc(u.id)+'\\')">保存</button></div><div class="muted" style="margin-top:5px">50–700 MB / 用户，默认 700 MB</div></div></div>'}).join('')}
async function saveRetention(id){var input=document.getElementById('retention-'+id);var limit=Number(input&&input.value);if(!Number.isFinite(limit)||limit<50||limit>700){alert('请输入 50–700 MB');return}try{var data=await api('/retention',{userId:id,limitMB:limit});if(data.cleanup&&data.cleanup.pruned)alert('设置已保存，并已自动清理 '+Number(data.cleanup.deletedMessages||0)+' 条较早消息。');await refreshAll()}catch(e){alert(e.message)}}
`;

function enhanceAdminHtml(source: string): string {
  let html = source.replace('<span class="tag blue">v0.4</span>', '<span class="tag blue">v0.5</span>');
  const settingsMarker = '<section class="section" id="section-settings">';
  if (html.includes(settingsMarker) && !html.includes('id="retentionSettings"')) {
    html = html.replace(settingsMarker, settingsMarker + RETENTION_CARD);
  }
  const oldLoadUsers = "async function loadUsers(){var data=await api('/users');state.users=data.users||[];renderUsers();renderOverview();renderUserFilter()}";
  if (html.includes(oldLoadUsers)) {
    html = html.replace(oldLoadUsers, "async function loadUsers(){var data=await api('/users');state.users=data.users||[];renderUsers();renderOverview();renderUserFilter();renderRetentionSettings()}");
  }
  const jsMarker = 'function renderUserFilter(){';
  if (html.includes(jsMarker) && !html.includes('function renderRetentionSettings(){')) {
    html = html.replace(jsMarker, RETENTION_JS + jsMarker);
  }
  return html;
}

async function handleRetentionAdmin(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authProbe = await baseWorker.fetch(request.clone(), env, ctx);
  if (authProbe.status === 403) return authProbe;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const userId = normalizeProfileId(body.userId);
    const upstream = await userStub(env, userId).fetch("https://weixin-bot.internal/retention", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limitMB: body.limitMB }),
    } as any);
    return adaptDoResponse(upstream as any);
  } catch (error) {
    return Response.json({ error: "retention_admin_error", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/setup") return new Response("Not Found", { status: 404 });

    if (url.pathname === "/admin/api/retention") {
      if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
      return handleRetentionAdmin(request, env, ctx);
    }

    const response = await baseWorker.fetch(request, env, ctx);
    if (url.pathname === "/admin" && response.ok) {
      const html = enhanceAdminHtml(await response.text());
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(html, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
};
