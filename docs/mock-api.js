// Статическое демо: подменяет /api/* записанными ответами настоящего прогона агента.
// Бэкенд, агент и правила безопасности в публичную витрину не входят.
(function () {
  "use strict";
  const R = window.DEMO_RECORDINGS;
  const pending = new Map();
  let faultMode = false;
  const realFetch = window.fetch.bind(window);

  const reply = (body, status = 200, delay = 0) => new Promise((resolve) => setTimeout(() => resolve(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })), delay));
  const pendingList = () => [...pending.values()];

  window.fetch = (input, opts = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const at = url.pathname.indexOf("/api/");
    if (at < 0) return realFetch(input, opts);
    const path = url.pathname.slice(at);
    const body = opts.body ? JSON.parse(opts.body) : {};

    if (path === "/api/health") return reply({ ok: true, llm: "демо-запись" });

    if (path === "/api/chat") {
      const text = (body.message || "").trim();
      const rec = faultMode && R.fault && /остат|баланс/i.test(text) ? R.fault : R.chat[text];
      if (faultMode && rec === R.fault) faultMode = false;
      if (!rec) {
        return reply({ session_id: "demo", trace_id: null, steps: [], pending: pendingList(),
          answer: "Это **статическое демо**: оно воспроизводит записанные ответы агента для сценариев-кнопок " +
            "под чатом. Полная версия с LLM работает на нашем сервере." }, 200, 300);
      }
      (rec.new_pending || []).forEach((p) => pending.set(p.payment_id, p));
      return reply({ ...rec, session_id: "demo", pending: pendingList() }, 200, 600);
    }

    if (/^\/api\/sessions\/[^/]+\/pending$/.test(path)) return reply(pendingList());

    let m = path.match(/^\/api\/payments\/([^/]+)\/confirm$/);
    if (m) {
      const p = pending.get(m[1]);
      if (!p) return reply({ detail: { code: "NOT_PENDING", message: "Платёж не ожидает подтверждения" } }, 404);
      if (p.confirmation === "strong" && body.otp !== p.demo_otp) {
        return reply({ detail: { code: "OTP_INVALID", message: "Неверный код подтверждения" } }, 400);
      }
      pending.delete(m[1]);
      const ts = new Date().toISOString().slice(0, 19);
      return reply({
        payment: { id: p.payment_id, amount: p.amount, status: "executed" }, counterparty_name: p.counterparty_name,
        document: p.document,
        timeline: [...(p.timeline || []),
          { status: "confirmed", ts, label: "Подтверждён пользователем" + (p.confirmation === "strong" ? " кодом" : "") },
          { status: "executed", ts, label: "Исполнен банком" }],
      }, 200, 300);
    }

    m = path.match(/^\/api\/payments\/([^/]+)\/cancel$/);
    if (m) { pending.delete(m[1]); return reply({ payment_id: m[1], status: "cancelled" }); }

    if (path === "/api/audit") return reply(R.audit[url.searchParams.get("trace_id")] || []);
    if (path === "/api/demo/faults") { faultMode = true; return reply({ next: 3 }); }
    if (path === "/api/demo/reset") { pending.clear(); faultMode = false; return reply({ ok: true }); }
    return reply({ detail: "not found" }, 404);
  };
})();
