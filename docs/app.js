"use strict";

const state = { sessionId: localStorage.getItem("sessionId"), busy: false };
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Мини-markdown: **жирный**, `код`, списки, абзацы. HTML экранируется заранее.
function md(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = []; let list = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-•]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (!list || list.tag !== tag) { if (list) out.push(`</${list.tag}>`); list = { tag }; out.push(`<${tag}>`); }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list.tag}>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list.tag}>`);
  return out.join("");
}

function addMessage(role, text, { html = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="bubble">${html ? text : md(text)}</div>`;
  $("messages").appendChild(wrap);
  $("messages").scrollTop = $("messages").scrollHeight;
  return wrap;
}

const money = (x) => Number(x).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}) });
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) {
    const d = data?.detail;
    const msg = typeof d === "object" && d?.message ? d.message : (typeof d === "string" ? d : `Ошибка ${res.status}`);
    throw Object.assign(new Error(msg), { code: d?.code, status: res.status });
  }
  return data;
}

const STEP_LABEL = { thought: "план", tool_call: "вызов", tool_result: "ответ", policy: "правила", error: "ошибка",
  verify: "проверка" };

function renderSteps(steps, traceId) {
  state.traceId = traceId;
  $("trace-id").textContent = traceId ? `trace ${traceId}` : "";
  if (!$("audit").hidden) loadAudit();
  const ol = $("steps");
  ol.innerHTML = "";
  if (!steps?.length) { ol.innerHTML = `<li class="empty">Агент ответил без обращения к банку</li>`; return; }
  for (const s of steps) {
    const li = document.createElement("li");
    li.className = `step ${s.type}${s.type === "verify" && s.detail && !s.detail.ok ? " bad" : ""}`;
    const detail = s.detail == null ? "" : typeof s.detail === "string"
      ? `<div>${md(s.detail)}</div>`
      : `<details><summary>данные</summary><pre>${esc(JSON.stringify(s.detail, null, 2))}</pre></details>`;
    li.innerHTML = `<div><span class="k">${STEP_LABEL[s.type] ?? s.type}</span><span class="t">${esc(s.title)}</span></div>${detail}`;
    ol.appendChild(li);
  }
}

function renderPending(list) {
  const box = $("pending");
  box.innerHTML = "";
  state.pending = list ?? [];
  $("confirm-all").hidden = state.pending.filter((p) => p.confirmation === "normal").length < 2;
  if (!list?.length) { box.innerHTML = `<p class="empty">Нет платежей на подтверждение</p>`; return; }
  for (const p of list) {
    const strong = p.confirmation === "strong";
    const card = document.createElement("div");
    card.className = `card${strong ? " strong" : ""}`;
    card.innerHTML = `
      <div class="row"><span class="who">${esc(p.counterparty_name)}</span><span class="amount">${money(p.amount)} BYN</span></div>
      <div class="purpose">${esc(p.purpose)}</div>
      ${renderTimeline(p.timeline, true)}
      ${renderDocument(p.document)}
      ${p.findings.map((f) => `<div class="finding ${f.severity}">${esc(f.message)}</div>`).join("")}
      ${strong ? `<div class="otp"><input placeholder="Код" inputmode="numeric" maxlength="6">
        <span class="hint">SMS (симуляция): <b class="mono">${esc(p.demo_otp)}</b></span></div>` : ""}
      <div class="actions"><button class="primary" data-act="confirm">Подтвердить</button>
        <button class="ghost" data-act="cancel">Отменить</button></div>
      <div class="err"></div>`;
    card.querySelector('[data-act="confirm"]').onclick = () => confirmPayment(p, card);
    card.querySelector('[data-act="cancel"]').onclick = () => cancelPayment(p, card);
    box.appendChild(card);
  }
}

const FUTURE_STEPS = [{ status: "confirmed", label: "Подтверждение пользователем" },
  { status: "executed", label: "Исполнение банком" }];

function renderTimeline(timeline, withFuture) {
  if (!timeline?.length) return "";
  const done = timeline.map((t) => `<li class="done" title="${esc(t.ts ?? "")}">${esc(t.label)}</li>`);
  const todo = withFuture ? FUTURE_STEPS.filter((f) => !timeline.some((t) => t.status === f.status))
    .map((f) => `<li class="todo">${esc(f.label)}</li>`) : [];
  return `<ol class="timeline">${done.join("")}${todo.join("")}</ol>`;
}

function renderDocument(d) {
  if (!d?.title) return "";
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  return `<details class="doc"><summary>${esc(d.title)} от ${esc(d.date)}</summary><table>
    ${row("Плательщик", `${esc(d.payer.name)}<br><span class="mono">УНП ${esc(d.payer.unp)} · ${esc(d.payer.iban)}</span>`)}
    ${row("Получатель", `${esc(d.payee.name)}<br><span class="mono">УНП ${esc(d.payee.unp)} · ${esc(d.payee.iban)} · BIC ${esc(d.payee.bic)}</span>`)}
    ${row("Сумма", `<b>${money(d.amount)} ${esc(d.currency)}</b><br>${esc(d.amount_words)}`)}
    ${row("Назначение", esc(d.purpose))}
    ${row("Основание", esc(d.basis))}
  </table></details>`;
}

async function refreshPending() {
  if (!state.sessionId) return renderPending([]);
  const res = await fetch(`/api/sessions/${state.sessionId}/pending`);
  renderPending(res.ok ? await res.json() : []);
}

async function confirmPayment(p, card, { silent = false } = {}) {
  const otp = card.querySelector(".otp input")?.value?.trim();
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    const r = await api(`/api/payments/${p.payment_id}/confirm`, { session_id: state.sessionId, otp });
    addMessage("system", `✓ ${esc(r.document?.title ?? r.payment.id)} исполнено: ${esc(r.counterparty_name)}, ${money(r.payment.amount)} BYN`
      + renderTimeline(r.timeline, false), { html: true });
    if (!silent) await refreshPending();
  } catch (e) {
    card.querySelector(".err").textContent = e.message;
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    if (e.code !== "OTP_INVALID" && e.code !== "BANK_UNAVAILABLE") {
      addMessage("system", `✗ Платёж ${p.payment_id} не исполнен: ${e.message}`);
      await refreshPending();
    }
  }
}

async function cancelPayment(p, card) {
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await api(`/api/payments/${p.payment_id}/cancel`, { session_id: state.sessionId });
    addMessage("system", `Платёж ${p.payment_id} отменён`);
  } catch (e) { card.querySelector(".err").textContent = e.message; }
  await refreshPending();
}

async function send(text) {
  if (state.busy || !text.trim()) return;
  state.busy = true; $("send").disabled = true;
  addMessage("user", text);
  const typing = addMessage("agent", `<span class="typing">Агент работает…</span>`, { html: true });
  try {
    const r = await api("/api/chat", { message: text, session_id: state.sessionId });
    state.sessionId = r.session_id; localStorage.setItem("sessionId", r.session_id);
    typing.remove();
    addMessage("agent", r.answer);
    renderSteps(r.steps, r.trace_id);
    renderPending(r.pending);
  } catch (e) {
    typing.remove();
    addMessage("system", `Ошибка запроса: ${e.message}`);
  } finally { state.busy = false; $("send").disabled = false; $("input").focus(); }
}

$("form").addEventListener("submit", (e) => { e.preventDefault(); const v = $("input").value; $("input").value = ""; send(v); });
$("chips").addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") send(e.target.textContent); });
$("confirm-all").addEventListener("click", async () => {
  const cards = [...$("pending").querySelectorAll(".card:not(.strong)")];
  const normal = state.pending.filter((p) => p.confirmation === "normal");
  for (let i = 0; i < normal.length; i++) await confirmPayment(normal[i], cards[i], { silent: true });
  await refreshPending();
});

async function loadAudit() {
  const box = $("audit");
  if (!state.traceId) { box.innerHTML = `<p class="empty">Сначала отправьте запрос</p>`; return; }
  const events = await (await fetch(`/api/audit?trace_id=${state.traceId}`)).json();
  const skip = new Set(["ts", "level", "logger", "event", "trace_id", "session_id"]);
  box.innerHTML = events.map((e) => {
    const kv = Object.entries(e).filter(([k]) => !skip.has(k))
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join("  ");
    return `<div class="ev ${e.level}"><span class="ts">${esc(new Date(e.ts).toLocaleTimeString("ru-RU"))}</span>
      <span><span class="name">${esc(e.event)}</span> <span class="kv">${esc(kv)}</span></span></div>`;
  }).join("") || `<p class="empty">Событий нет</p>`;
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $("steps").hidden = t.dataset.tab !== "steps";
  $("audit").hidden = t.dataset.tab !== "audit";
  if (t.dataset.tab === "audit") loadAudit();
}));

// Голосовой ввод (Web Speech API, если браузер поддерживает)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR && $("mic")) {
  const rec = new SR(); rec.lang = "ru-RU"; rec.interimResults = false;
  $("mic").hidden = false;
  $("mic").onclick = () => { $("mic").classList.add("rec"); rec.start(); };
  rec.onresult = (e) => { const t = e.results[0][0].transcript; $("input").value = t; send(t); $("input").value = ""; };
  rec.onend = () => $("mic").classList.remove("rec");
}

$("fault-btn").addEventListener("click", async () => {
  await api("/api/demo/faults", { next: 3 });
  addMessage("system", "Демо: следующие 3 запроса к банку вернут ошибку 503 (агент повторит запрос и объяснит ситуацию).");
});
$("reset-btn").addEventListener("click", async () => {
  await api("/api/demo/reset");
  localStorage.removeItem("sessionId"); state.sessionId = null; location.reload();
});

fetch("/api/health").then((r) => r.json()).then((h) => { $("llm-badge").textContent = `LLM: ${h.llm}`; }).catch(() => {});
refreshPending();
