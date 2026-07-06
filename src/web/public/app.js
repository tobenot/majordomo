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
    assetNames: [],
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
        state.assetNames = msg.assetNames || [];
        el("personaName").textContent = msg.personaName;
        el("engineBadge").textContent = "人设: " + msg.personaName;
        var label = el("sidebarLabel");
        if (label) label.textContent = msg.personaName;
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
        applyPersona(msg.windowId, msg.text, msg.personaMessages);
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

  function applyPersona(id, text, personaMessages) {
    const w = state.windows.find((x) => x.windowId === id);
    if (!w) return;
    w.lastPersona = text;
    if (personaMessages) w.personaMessages = personaMessages;
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
      var hasMissAlert = w.metrics && w.metrics.missPercent > 0.04;
      if (hasMissAlert) li.classList.add("window-alert");
      li.innerHTML =
        '<div class="s-name"><span class="dot ' + w.state + '"></span>' +
        escapeHtml(w.title) +
        '</div><div class="s-meta">' +
        (STATE_LABEL[w.state] || w.state) +
        " · " +
        escapeHtml(oneLine(w.lastSummary || w.lastText || "", 60)) +
        "</div>" +
        (w.metrics ? metricsSummary(w.metrics) : "");
      li.onclick = () => selectWindow(w.windowId);
      ul.appendChild(li);
    });
  }

  function selectWindow(id) {
    state.current = id;
    renderWindows();
    renderDetail();
    loadImages(id);
  }

  // ── 立绘 / CG ──────────────────────────────────────────
  function pickRandom(arr) {
    if (!arr || !arr.length) return "";
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function assetUrl(kind, name) {
    if (!name) return "";
    var safe = String(name).replace(/[^a-zA-Z0-9一-鿿_-]/g, "_");
    return "assets/" + kind + "/" + safe + ".webp";
  }

  function loadImg(el, src) {
    if (!src) { el.classList.remove("loaded"); el.src = ""; return; }
    el.onload = function () { el.classList.add("loaded"); };
    el.onerror = function () { el.classList.remove("loaded"); el.src = ""; };
    el.src = src;
  }

  function loadImages(windowId) {
    var name = pickRandom(state.assetNames) || state.personaName || "";
    // CG 作为氛围底板：铺在人设消息区顶部，压暗渐隐
    var cgSrc = assetUrl("cg", name);
    var amb = el("cgAmbient");
    if (amb && cgSrc) {
      var probe = new Image();
      probe.onload = function () { amb.style.backgroundImage = "url('" + cgSrc + "')"; amb.classList.add("loaded"); };
      probe.onerror = function () { amb.style.backgroundImage = ""; amb.classList.remove("loaded"); };
      probe.src = cgSrc;
    } else if (amb) {
      amb.style.backgroundImage = ""; amb.classList.remove("loaded");
    }
    loadImg(el("standingPanel"), assetUrl("standing", name));
    loadImg(el("cgImg"), assetUrl("cg", name));
  }

  function renderDetail() {
    const w = state.windows.find((x) => x.windowId === state.current);
    const pScroll = el("personaScroll");
    const actWrap = el("activityWrap");
    const act = el("activity");
    if (!w) {
      el("detailTitle").textContent = "选一个窗口看它在做什么";
      el("detailState").textContent = "";
      el("detailState").className = "badge";
      if (pScroll) pScroll.innerHTML = "";
      actWrap.classList.add("hidden");
      return;
    }
    el("detailTitle").textContent = w.title + "  ·  " + w.cwd;
    const sb = el("detailState");
    sb.textContent = STATE_LABEL[w.state] || w.state;
    sb.className = "badge state-" + w.state;

    // 人设消息历史（气泡流，最早在上，最新在下）
    var msgs = w.personaMessages || [];
    if (msgs.length) {
      var html = '<div class="persona-msgs">';
      for (var i = 0; i < msgs.length; i++) {
        html +=
          '<div class="persona-bubble">' +
          '<div class="persona-bubble-head">' +
          '<span class="persona-who">' + escapeHtml(state.personaName) + '</span>' +
          '<span class="persona-ts">' + fmtTime(msgs[i].ts) + '</span>' +
          '</div>' +
          '<div class="persona-bubble-body md">' + window.MjMarkdown.render(msgs[i].text) + '</div>' +
          '</div>';
      }
      html += '</div>';
      pScroll.innerHTML = html;
    } else {
      pScroll.innerHTML = '<div class="persona-msgs empty">还没有人设消息</div>';
    }

    // 会话度量
    el("metricsArea").innerHTML = metricsDetail(w.metrics);

    // Activity 日志（折叠）
    var acts = (w.activity || []).slice().reverse();
    if (acts.length) {
      actWrap.classList.remove("hidden");
      el("actCount").textContent = acts.length;
      act.innerHTML = "";
      for (var j = 0; j < acts.length; j++) {
        var a = acts[j];
        var row = document.createElement("div");
        row.className = "act-row";
        row.innerHTML =
          '<span class="act-ts">' + fmtTime(a.ts) + '</span>' +
          '<span class="act-ev ev-' + escapeHtml(a.event) + '">' + escapeHtml(a.event) + "</span>" +
          '<span class="act-sum">' + escapeHtml(a.summary) + "</span>";
        act.appendChild(row);
      }
    } else {
      actWrap.classList.add("hidden");
    }
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
    // 赛博朋克告警：有任何 pending alert → header 灯条变红
    var hasAlert = pending.some(function (a) { return a.kind === "alert"; });
    document.body.classList.toggle("alert-active", hasAlert);
    el("accCount").classList.toggle("count-alert", hasAlert);
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

  function metricsSummary(m) {
    if (!m || !m.totalRounds) return "";
    var pct = Math.round(m.missPercent * 100);
    var slow = Math.round(m.latencyMaxMs / 1000);
    var alertClass = m.missPercent > 0.04 ? " metrics-alert" : "";
    return '<div class="s-metrics' + alertClass + '">miss ' + pct + '% · ' + m.totalRounds + '轮 · 慢峰' + slow + 's</div>';
  }

  function metricsDetail(m) {
    if (!m || !m.totalRounds) return "";
    return (
      '<div class="metrics-card' + (m.missPercent > 0.04 ? ' metrics-card-alert' : '') + '">' +
      '<div class="metrics-title">会话度量</div>' +
      '<div class="metrics-grid">' +
        metricsKV('miss%', Math.round(m.missPercent * 100) + '%') +
        metricsKV('最近段 miss%', Math.round(m.lastSegmentMissPercent * 100) + '%') +
        metricsKV('塌方峰值', Math.round(m.maxSingleRoundInput).toLocaleString() + ' token') +
        metricsKV('累计产出', Math.round(m.cumulativeOutputTokens).toLocaleString() + ' token') +
        metricsKV('总轮数', String(m.totalRounds)) +
        metricsKV('会话时长', fmtDuration(m.sessionDurationMs)) +
        metricsKV('每轮耗时中位', fmtMs(m.latencyMedianMs)) +
        metricsKV('每轮耗时 p90', fmtMs(m.latencyP90Ms)) +
        metricsKV('每轮耗时 max', fmtMs(m.latencyMaxMs)) +
        metricsKV('tool_use 比', Math.round(m.toolUseRatio * 100) + '%') +
        metricsKV('最长 turn', fmtMs(m.maxTurnDurationMs)) +
        metricsKV('工具报错', String(m.toolErrorCount)) +
        (m.aiTitle ? metricsKV('标题', escapeHtml(m.aiTitle)) : "") +
        (m.gitBranch ? metricsKV('分支', escapeHtml(m.gitBranch)) : "") +
        (m.permissionMode ? metricsKV('权限', escapeHtml(m.permissionMode)) : "") +
        (m.topTools && m.topTools.length ? metricsKV('常用工具', m.topTools.map(function (t) { return t[0] + '(' + t[1] + ')'; }).join(', ')) : "") +
      '</div></div>');
  }

  function metricsKV(label, val) {
    return '<div class="metrics-kv"><span class="mk">' + escapeHtml(label) + '</span><span class="mv">' + escapeHtml(val) + '</span></div>';
  }

  function fmtMs(ms) { return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's'; }
  function fmtDuration(ms) {
    var m = Math.floor(ms / 60000);
    var h = Math.floor(m / 60);
    m = m % 60;
    return h > 0 ? h + 'h' + m + 'm' : m + 'm';
  }

  function renderAll() {
    renderWindows();
    renderDetail();
    loadImages();
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

  // 清空按钮
  var btnClearTodos = el("btnClearTodos");
  if (btnClearTodos) btnClearTodos.onclick = function () { send({ type: "todo_clear_all" }); };
  var btnClearAcc = el("btnClearAcc");
  if (btnClearAcc) btnClearAcc.onclick = function () { send({ type: "acceptance_clear_all" }); };

  // 恢复弹窗
  var btnRestore = el("btnPopupRestore");
  if (btnRestore) btnRestore.onclick = function () { send({ type: "popup_restore" }); };

  connect();
})();
