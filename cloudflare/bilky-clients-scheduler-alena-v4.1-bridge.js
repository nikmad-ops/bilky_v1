const CLIENTS = [
  { id: "nik", name: "Nik", repo: "nikmad-ops/bilky_v1", scheduled: false },
  { id: "alena", name: "Alena", repo: "nikmad-ops/bilky_client_01", scheduled: false },
  { id: "irakli", name: "Irakli", repo: "nikmad-ops/bilky_client_02", scheduled: false },
];

const TELEGRAM_API = "https://api.telegram.org";
const WORKFLOW = "workshift-production.yml";
const STATUS_WORKFLOW = "status-report.yml";
const MAX_ATTEMPTS = 5;
const TTL = 172800;

function parts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date).map(({type,value}) => [type,value]));
}
function dateKey(p) { return `${p.year}-${p.month}-${p.day}`; }
function displayDate(d) { const [y,m,day]=d.split("-"); return `${day}.${m}.${y}`; }
function mins(p) { return Number(p.hour)*60+Number(p.minute); }
function weekday(p) { return ["Mon","Tue","Wed","Thu","Fri"].includes(p.weekday); }
function clientById(id) { return CLIENTS.find(c => c.id === id); }

function windowInfo(p, action) {
  const now = mins(p);
  const w = action === "morning"
    ? {start:475,end:505,monitorEnd:525}
    : {start:990,end:1020,monitorEnd:1040};
  return { active: now>=w.start && now<=w.monitorEnd, canDispatch: now>=w.start && now<=w.end, afterDispatchWindow: now>w.end };
}

async function gh(env, path, options={}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bilky-clients-scheduler-v3",
      "Content-Type": "application/json",
      ...(options.headers||{})
    }
  });
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}: ${await r.text()}`);
  return r.status===204 ? null : r.json();
}

async function dispatch(env, client, mode, action, attempt, requestId) {
  await gh(env, `/repos/${client.repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method:"POST",
    body: JSON.stringify({
      ref:"main",
      inputs:{
        mode,
        action,
        attempt:String(attempt),
        request_id:requestId,
        execute:"true"
      }
    })
  });
}

async function inspect(env, client, mode, action, attempt, requestId, dispatchedAt) {
  const runs = await gh(env, `/repos/${client.repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=40`);
  const title = `Bilky ${mode} ${action} attempt ${attempt} ${requestId}`;
  const run = (runs.workflow_runs||[]).find(x => x.display_title===title);
  if (!run) {
    if (Date.now()-Date.parse(dispatchedAt) < 180000) return {state:"pending"};
    return {state:"failed",reason:"run-not-found"};
  }
  if (run.status!=="completed") return {state:"pending",runId:run.id};
  if (run.conclusion==="success") return {state:"success",runId:run.id};
  return {state:"failed",runId:run.id,reason:run.conclusion||"unknown"};
}

async function tg(token, method, payload) {
  const r = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`Telegram ${method} HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}
async function send(token, chat, text, extra={}) {
  return tg(token,"sendMessage",{chat_id:chat,text,...extra});
}
async function answer(token,id) { return tg(token,"answerCallbackQuery",{callback_query_id:id}); }

async function getState(env,key) {
  const raw=await env.STATE.get(key);
  if (!raw) return {attempts:0,pending:null,done:false,finalErrorSent:false};
  try { return JSON.parse(raw); } catch { return {attempts:0,pending:null,done:false,finalErrorSent:false}; }
}
async function putState(env,key,state) {
  await env.STATE.put(key,JSON.stringify(state),{expirationTtl:TTL});
}

async function notifyFinalError(env, client, action, state, manual=false) {
  if (state.finalErrorSent) return;
  const label=action==="morning"?"Morning":"Evening";
  const text=`❌ Bilky for ${client.name} ${displayDate(state.date)}: ${label}. ERROR after ${state.attempts}/${MAX_ATTEMPTS} attempts`;
  if (client.id==="nik") {
    await send(env.ADMIN_TELEGRAM_BOT_TOKEN,env.ADMIN_TELEGRAM_CHAT_ID,text);
  } else {
    await send(env.ALENA_TELEGRAM_BOT_TOKEN,env.ALENA_TELEGRAM_CHAT_ID,text);
    await send(env.ADMIN_TELEGRAM_BOT_TOKEN,env.ADMIN_TELEGRAM_CHAT_ID,text);
  }
  state.finalErrorSent=true;
}

async function processState(env, client, stateKey, state, mode, canDispatch=true) {
  if (state.done) return;

  if (state.pending) {
    const i=await inspect(env,client,mode,state.action,state.pending.attempt,state.pending.requestId,state.pending.dispatchedAt);
    if (i.state==="pending") return;
    if (i.state==="success") {
      state.done=true; state.pending=null; state.completedRunId=i.runId||null; state.completedAt=new Date().toISOString();
      await putState(env,stateKey,state);
      if (mode==="manual" && state.activeKey) await env.STATE.delete(state.activeKey);
      return;
    }
    state.lastFailure={at:new Date().toISOString(),runId:i.runId||null,reason:i.reason||"unknown"};
    state.pending=null;
    await putState(env,stateKey,state);
  }

  if (state.attempts>=MAX_ATTEMPTS) {
    await notifyFinalError(env,client,state.action,state,mode==="manual");
    await putState(env,stateKey,state);
    if (mode==="manual" && state.activeKey) await env.STATE.delete(state.activeKey);
    return;
  }

  if (!canDispatch) return;

  const attempt=state.attempts+1;
  const requestId=`${state.baseRequestId}-${attempt}`;
  state.attempts=attempt;
  state.pending={attempt,requestId,dispatchedAt:new Date().toISOString()};
  await putState(env,stateKey,state);
  try {
    await dispatch(env,client,mode,state.action,attempt,requestId);
  } catch(e) {
    state.attempts=attempt-1; state.pending=null; await putState(env,stateKey,state); throw e;
  }
}

async function processScheduled(env, client, nowDate) {
  if (!client.scheduled) return;
  const p=parts(nowDate);
  if (!weekday(p)) return;
  const date=dateKey(p);

  for (const action of ["morning","evening"]) {
    const w=windowInfo(p,action);
    if (!w.active) continue;
    const key=`v3:scheduled:${client.id}:${date}:${action}`;
    const state=await getState(env,key);
    state.date=date; state.action=action; state.baseRequestId=`v3-${client.id}-${date}-${action}`;

    await processState(env,client,key,state,"scheduled",w.canDispatch);

    const latest=await getState(env,key);
    if (!latest.done && !latest.pending && latest.attempts>=MAX_ATTEMPTS) {
      await notifyFinalError(env,client,action,latest,false);
      await putState(env,key,latest);
    } else if (!latest.done && !latest.pending && w.afterDispatchWindow) {
      await notifyFinalError(env,client,action,latest,false);
      await putState(env,key,latest);
    }
  }
}

async function processManualActive(env) {
  const listed=await env.STATE.list({prefix:"v3:manual-active:"});
  for (const key of listed.keys||[]) {
    const runId=await env.STATE.get(key.name);
    if (!runId) continue;
    const stateKey=`v3:manual:${runId}`;
    const state=await getState(env,stateKey);
    const client=clientById(state.clientId);
    if (!client) { await env.STATE.delete(key.name); continue; }
    await processState(env,client,stateKey,state,"manual",true);
  }
}

async function startManual(env, role, clientId, action) {
  const p=parts();
  if (!weekday(p)) return {ok:false,weekend:true};
  const client=clientById(clientId);
  if (!client || !["morning","evening"].includes(action)) return {ok:false,error:"invalid-selection"};

  const date=dateKey(p);
  const activeKey=`v3:manual-active:${date}:${client.id}:${action}`;
  const existing=await env.STATE.get(activeKey);
  if (existing) return {ok:false,alreadyRunning:true};

  const runId=`manual-${date}-${client.id}-${action}-${Date.now()}`;
  const stateKey=`v3:manual:${runId}`;
  const state={
    date, clientId:client.id, action, attempts:0, pending:null, done:false,
    finalErrorSent:false, baseRequestId:runId, activeKey, role
  };
  await env.STATE.put(activeKey,runId,{expirationTtl:TTL});
  await putState(env,stateKey,state);
  await processState(env,client,stateKey,state,"manual",true);
  return {ok:true,client,action,runId};
}

function isStatus(text) {
  return ["status","/status","статус","/статус"].includes(String(text||"").trim().toLowerCase());
}
function isRun(text) {
  return ["run","/run","запуск","/запуск"].includes(String(text||"").trim().toLowerCase());
}

function targetKeyboard(ids,prefix) {
  return {inline_keyboard:ids.map(id=>{const c=clientById(id);return [{text:c.name,callback_data:`${prefix}:${id}`}];})};
}
function actionKeyboard(clientId,prefix) {
  return {inline_keyboard:[[
    {text:"Утро",callback_data:`${prefix}:${clientId}:morning`},
    {text:"Вечер",callback_data:`${prefix}:${clientId}:evening`}
  ]]};
}

async function callV41(env,path,payload) {
  const r=await env.NIK_V4.fetch("https://nik-v4.internal"+path,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload)
  });
  const text=await r.text();
  let data={};
  try { data=JSON.parse(text); } catch { data={ok:false,error:text||("HTTP "+r.status)}; }
  if (!r.ok || !data.ok) {
    throw new Error(data.error || ("Nik v4 HTTP "+r.status));
  }
  return data;
}

async function dispatchStatus(env,client,chatId,requestId,role="admin",recipient="admin") {
  if (client.id==="nik" || client.id==="alena" || client.id==="irakli") {
    return callV41(env,"/internal/status",{
      role,
      client_id:client.id,
      recipient,
      chat_id:String(chatId),
      request_id:String(requestId||Date.now())
    });
  }

  await gh(env,`/repos/${client.repo}/actions/workflows/${STATUS_WORKFLOW}/dispatches`,{
    method:"POST",
    body:JSON.stringify({ref:"main",inputs:{chat_id:String(chatId),mode:"status"}})
  });
}

async function handleAdminMessage(env,msg) {
  const chat=String(msg.chat?.id||"");
  if (chat!==String(env.ADMIN_TELEGRAM_CHAT_ID)) return;
  if (isStatus(msg.text)) {
    await send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,"Whose Bilky status do you need?",{reply_markup:targetKeyboard(["nik","alena","irakli"],"status")});
    return;
  }
  if (isRun(msg.text)) {
    if (!weekday(parts())) { await send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,"Сегодня выходной. Запуск недоступен."); return; }
    await send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,"Кого запустить?",{reply_markup:targetKeyboard(["nik","alena","irakli"],"run-target")});
  }
}

async function handleAdminCallback(env,cb) {
  const chat=String(cb.message?.chat?.id||"");
  if (chat!==String(env.ADMIN_TELEGRAM_CHAT_ID)) return;
  await answer(env.ADMIN_TELEGRAM_BOT_TOKEN,cb.id);
  const data=String(cb.data||"");

  if (data.startsWith("status:")) {
    const c=clientById(data.slice(7));
    if (!c) return;
    await send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,`Loading Bilky status for ${c.name}...`);
    try { await dispatchStatus(env,c,chat,cb.id,"admin","admin"); } catch(e) { await send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,`Status request failed: ${e.message}`); }
    return;
  }
  if (data.startsWith("run-target:")) {
    const id=data.slice("run-target:".length);
    const c=clientById(id); if(!c) return;
    await send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,`Что запустить для ${c.name}?`,{reply_markup:actionKeyboard(id,"run-action")});
    return;
  }
  if (data.startsWith("run-action:")) {
    const [,id,action]=data.split(":");

    if (id==="nik" || id==="alena" || id==="irakli") {
      try {
        const r=await callV41(env,"/internal/manual",{
          role:"admin",
          client_id:id,
          action,
          request_id:String(cb.id)
        });
        const label=action==="morning"?"Morning":"Evening";
        if (r.weekend) return send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,"Сегодня выходной. Запуск недоступен.");
        if (r.nonWorkingDay) {
          return send(
            env.ADMIN_TELEGRAM_BOT_TOKEN,
            chat,
            `Bilky for ${clientById(id).name}: ${r.date} is a non-working day${r.reason ? ` (${r.reason})` : ""}. Run is blocked.`
          );
        }
        return send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,`Bilky for ${clientById(id).name}: ${label} started. Automatic recovery is enabled (up to 15 attempts).`);
      } catch(e) {
        return send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,`Bilky for ${clientById(id).name}: could not start the run. ${e.message}`);
      }
    }

    const r=await startManual(env,"admin",id,action);
    if (r.weekend) return send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,"Сегодня выходной. Запуск недоступен.");
    if (r.alreadyRunning) return send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,"Такой ручной запуск уже выполняется.");
    if (!r.ok) return send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,"Не удалось создать ручной запуск.");
    const label=action==="morning"?"утро":"вечер";
    await send(env.ADMIN_TELEGRAM_BOT_TOKEN,chat,`Запуск: ${r.client.name}, ${label}. До 5 попыток. Автоповторы включены.`);
  }
}

async function handleAlenaMessage(env,msg) {
  const chat=String(msg.chat?.id||"");
  if (chat!==String(env.ALENA_TELEGRAM_CHAT_ID)) return;
  if (isStatus(msg.text)) {
    const c=clientById("alena");
    await send(env.ALENA_TELEGRAM_BOT_TOKEN,chat,"Loading your Bilky status...");
    try { await dispatchStatus(env,c,chat,msg.message_id,"alena","client"); } catch(e) { await send(env.ALENA_TELEGRAM_BOT_TOKEN,chat,`Status request failed: ${e.message}`); }
    return;
  }
  if (isRun(msg.text)) {
    if (!weekday(parts())) { await send(env.ALENA_TELEGRAM_BOT_TOKEN,chat,"Сегодня выходной. Запуск недоступен."); return; }
    await send(env.ALENA_TELEGRAM_BOT_TOKEN,chat,"Кого запустить?",{reply_markup:targetKeyboard(["alena","irakli"],"alena-run-target")});
  }
}

async function handleAlenaCallback(env,cb) {
  const chat=String(cb.message?.chat?.id||"");
  if (chat!==String(env.ALENA_TELEGRAM_CHAT_ID)) return;
  await answer(env.ALENA_TELEGRAM_BOT_TOKEN,cb.id);
  const data=String(cb.data||"");
  if (data.startsWith("alena-run-target:")) {
    const id=data.slice("alena-run-target:".length);
    if (!["alena","irakli"].includes(id)) return;
    const c=clientById(id);
    await send(env.ALENA_TELEGRAM_BOT_TOKEN,chat,`Что запустить для ${c.name}?`,{reply_markup:actionKeyboard(id,"alena-run-action")});
    return;
  }
  if (data.startsWith("alena-run-action:")) {
    const [, id, action]=data.split(":");
    if (!["alena","irakli"].includes(id)) return;

    if (id==="alena" || id==="irakli") {
      try {
        const r=await callV41(env,"/internal/manual",{
          role:"alena",
          client_id:id,
          action,
          request_id:String(cb.id)
        });
        if (r.weekend) return send(env.ALENA_TELEGRAM_BOT_TOKEN,chat,"Сегодня выходной. Запуск недоступен.");
        if (r.nonWorkingDay) {
          return send(
            env.ALENA_TELEGRAM_BOT_TOKEN,
            chat,
            `Bilky for ${clientById(id).name}: ${r.date} is a non-working day${r.reason ? ` (${r.reason})` : ""}. Run is blocked.`
          );
        }
        const label=action==="morning"?"Morning":"Evening";
        return send(env.ALENA_TELEGRAM_BOT_TOKEN,chat,`Bilky for ${clientById(id).name}: ${label} started. Automatic recovery is enabled (up to 15 attempts).`);
      } catch(e) {
        return send(env.ALENA_TELEGRAM_BOT_TOKEN,chat,`Bilky for ${clientById(id).name}: could not start the run. ${e.message}`);
      }
    }
  }
}

async function webhook(request,env,role) {
  const secret=request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  const expected=role==="admin"?env.ADMIN_WEBHOOK_SECRET:env.ALENA_WEBHOOK_SECRET;
  if (secret!==expected) return new Response("Unauthorized",{status:401});
  const u=await request.json();
  try {
    if (role==="admin") {
      if (u.callback_query) await handleAdminCallback(env,u.callback_query);
      else if (u.message) await handleAdminMessage(env,u.message);
    } else {
      if (u.callback_query) await handleAlenaCallback(env,u.callback_query);
      else if (u.message) await handleAlenaMessage(env,u.message);
    }
  } catch(e) { console.error(role+" webhook error",e); }
  return new Response("OK");
}

export default {
  async scheduled(event,env,ctx) {
    const d=new Date(event.scheduledTime);
    for (const c of CLIENTS) {
      try { await processScheduled(env,c,d); } catch(e) { console.error("scheduled",c.id,e); }
    }
    try { await processManualActive(env); } catch(e) { console.error("manual processor",e); }
  },
  async fetch(request,env,ctx) {
    const url=new URL(request.url);
    if (request.method==="POST" && url.pathname==="/telegram/admin") return webhook(request,env,"admin");
    if (request.method==="POST" && url.pathname==="/telegram/alena") return webhook(request,env,"alena");
    return new Response("Bilky clients scheduler v3 is running");
  }
};
