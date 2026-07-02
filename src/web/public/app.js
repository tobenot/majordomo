// majordomo 中枢面板：直连 core daemon 的 WebSocket，看三张表（窗口 / 待办 / 待验收）。
// v1 是逐窗口只读仪表盘：窗口 → Bifrost → 中枢 → 你（单向）。面板只做展示 + 待办/验收的轻量维护。
(function () {
  "use strict";

  const WS_URL = resolveWsUrl(window.__WS_URL__);
  const el = (id) => document.getElementById(id);

  function resolveWsUrl(raw) {
    const protocol = window.location.protocol === "https:" ? "wss://" : "ws://";
    if (String(raw).startsWith("__AUTO_WS__:")) {
      const port = String(raw).split(":")[1];
      return protocol + window.location.hostname + ":" + port;
    }
    if (window.location.protocol === "https:" && String(raw).startsWith("ws://")) {
      return "wss://" + String(raw).slice(5);
    }
    return raw;
  }

  const state = {
    ws: null,
    windows: [], // WindowInfo[]
    todos: [],
    acceptance: [],
    current: null, // 选中的 windowId
    personaName: "中枢",
  };

  const STATE_LABEL = { working: "干活中", waiting: "等你", idle: "空闲", offline: "离线" };

  // ── 连接 ──────────────────────────────────────────────
  function connect() {
    const ws = new WebSocket(WS_URL);
    state.ws = ws;
    ws.onopen = () => {
      setConn(true);
      send({ type: "hello", client: "web" });
    };
    ws.onclose = () => {
      setConn(false);
      setTimeout(connect, 2000);
    };
    ws.onerror = () => setConn(false);
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
  }

  function setConn(ok) {
    const b = el("connState");
    b.textContent = ok ? "已连接" : "未连接";
    b.className = "badge " + (ok ? "on" : "off");
  }

  // ── 消息处理 ──────────────────────────────────────────
  function onMessage(msg) {
    switch (msg.type) {
      case "welcome":
        state.personaName = msg.personaName;
        el("personaName").textContent = msg.personaName;
        el("engineBadge").textContent = "人设: " + msg.personaName;
        break;
      case "hub_snapshot":
        state.windows = msg.snapshot.windows || [];
        state.todos = msg.snapshot.todos || [];
        state.acceptance = msg.snapshot.acceptance || [];
        renderAll();
        break;
      case "window_update":
        upsertWindow(msg.window);
        break;
      case "window_offline":
        markOffline(msg.windowId);
        break;
      case "window_persona":
        applyPersona(msg.windowId, msg.text);
        break;
      case "todos":
        state.todos = msg.todos || [];
        renderTodos();
        break;
      case "acceptance":
        state.acceptance = msg.items || [];
        renderAcceptance();
        break;
      case "error":
        console.warn("中枢错误:", msg.message);
        break;
    }
  }

  // ── ① 窗口 ────────────────────────────────────────────
  function upsertWindow(w) {
    const i = state.windows.findIndex((x) => x.windowId === w.windowId);
    if (i >= 0) state.windows[i] = w;
    else state.windows.unshift(w);
    renderWindows();
    if (state.current === w.windowId) renderDetail();
  }

  function markOffline(id) {
    const w = state.windows.find((x) => x.windowId === id);
    if (w) w.state = "offline";
    renderWindows();
    if (state.current === id) renderDetail();
  }

  function applyPersona(id, text) {
    const w = state.windows.find((x) => x.windowId === id);
    if (w) w.lastPersona = text;
    if (state.current === id) renderDetail();
    renderWindows();
  }

  function sortedWindows() {
    return state.windows.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function renderWindows() {
    const ul = el("windowList");
    ul.innerHTML = "";
    const ws = sortedWindows();
    el("winCount").textContent = ws.filter((w) => w.state !== "offline").length;
    ws.forEach((w) => {
      const li = document.createElement("li");
      if (w.windowId === state.current) li.className = "active";
      li.innerHTML =
        '<div class="s-name"><span class="dot ' + w.state + '"></span>' +
        escapeHtml(w.title) +
        '</div><div class="s-meta">' +
        (STATE_LABEL[w.state] || w.state) +
        " · " +
        escapeHtml(oneLine(w.lastPersona || w.lastText || "", 40)) +
        "</div>";
      li.onclick = () => selectWindow(w.windowId);
      ul.appendChild(li);
    });
  }

  function selectWindow(id) {
    state.current = id;
    renderWindows();
    renderDetail();
  }

  function renderDetail() {
    const w = state.windows.find((x) => x.windowId === state.current);
    const pBox = el("personaBox");
    const act = el("activity");
    if (!w) {
      el("detailTitle").textContent = "选一个窗口看它在做什么";
      el("detailState").textContent = "";
      el("detailState").className = "badge";
      pBox.classList.add("hidden");
      act.innerHTML = "";
      return;
    }
    el("detailTitle").textContent = w.title + "  ·  " + w.cwd;
    const sb = el("detailState");
    sb.textContent = STATE_LABEL[w.state] || w.state;
    sb.className = "badge state-" + w.state;

    if (w.lastPersona) {
      pBox.classList.remove("hidden");
      pBox.innerHTML = '<div class="who">' + escapeHtml(state.personaName) + "</div><div class=\"body\">" + escapeHtml(w.lastPersona) + "</div>";
    } else {
      pBox.classList.add("hidden");
    }

    act.innerHTML = "";
    (w.activity || []).slice().reverse().forEach((a) => {
      const row = document.createElement("div");
      row.className = "act-row";
      row.innerHTML =
        '<span class="act-ts">' + fmtTime(a.ts) + '</span>' +
        '<span class="act-ev ev-' + escapeHtml(a.event) + '">' + escapeHtml(a.event) + "</span>" +
        '<span class="act-sum">' + escapeHtml(a.summary) + "</span>";
      act.appendChild(row);
    });
  }

  // ── ② 待办 ────────────────────────────────────────────
  function renderTodos() {
    const ul = el("todoList");
    ul.innerHTML = "";
    const open = state.todos.filter((t) => t.status === "open");
    el("todoCount").textContent = open.length;
    state.todos
      .slice()
      .sort((a, b) => (a.status === b.status ? a.createdAt - b.createdAt : a.status === "open" ? -1 : 1))
      .forEach((t) => {
        const li = document.createElement("li");
        li.className = "todo " + t.status;
        const win = state.windows.find((w) => w.windowId === t.windowId);
        li.innerHTML =
          '<input type="checkbox" ' + (t.status === "done" ? "checked" : "") + " />" +
          '<span class="todo-text">' + escapeHtml(t.text) + "</span>" +
          '<span class="todo-src">' + (win ? escapeHtml(win.title) : t.source) + "</span>" +
          '<button class="x" title="删除">×</button>';
        li.querySelector("input").onchange = (e) =>
          send({ type: "todo_set_status", id: t.id, status: e.target.checked ? "done" : "open" });
        li.querySelector(".x").onclick = () => send({ type: "todo_remove", id: t.id });
        ul.appendChild(li);
      });
  }

  el("todoForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = el("todoInput");
    const text = inp.value.trim();
    if (!text) return;
    send({ type: "todo_add", text: text, windowId: state.current || undefined });
    inp.value = "";
  });

  // ── ③ 待验收 ──────────────────────────────────────────
  function renderAcceptance() {
    const ul = el("acceptanceList");
    ul.innerHTML = "";
    const pending = state.acceptance.filter((a) => a.status === "pending");
    el("accCount").textContent = pending.length;
    state.acceptance
      .slice()
      .sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === "pending" ? -1 : 1))
      .forEach((a) => {
        const li = document.createElement("li");
        li.className = "acc " + a.status + " kind-" + a.kind;
        li.innerHTML =
          '<span class="acc-kind">' + escapeHtml(a.kind) + "</span>" +
          '<span class="acc-what">' + escapeHtml(a.what) + "</span>" +
          (a.status === "pending" ? '<button class="ok">已处理</button>' : '<span class="acc-done">✓</span>');
        const btn = li.querySelector("button");
        if (btn) btn.onclick = () => send({ type: "acceptance_resolve", id: a.id });
        ul.appendChild(li);
      });
  }

  function renderAll() {
    renderWindows();
    renderDetail();
    renderTodos();
    renderAcceptance();
  }

  // ── 工具 ──────────────────────────────────────────────
  function oneLine(s, n) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString(); } catch { return ""; }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  connect();
})();
