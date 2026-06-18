// majordomo Web 面板：直连 core daemon 的 WebSocket，看与 TUI 同一份状态。
(function () {
  "use strict";

  const WS_URL = window.__WS_URL__;
  const el = (id) => document.getElementById(id);

  const state = {
    ws: null,
    sessions: [],
    current: null,
    personaName: "指挥官",
    pendingPermission: null,
  };

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
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    }
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
        el("engineBadge").textContent = "工作层: " + msg.engine;
        fillProfiles(msg.profiles, msg.activeProfile);
        break;
      case "sessions":
        state.sessions = msg.sessions;
        renderSessions();
        break;
      case "session_created":
        upsertSession(msg.session);
        selectSession(msg.session.id);
        if (state.pendingFirstInput) {
          const t = state.pendingFirstInput;
          state.pendingFirstInput = null;
          addMessage("user", t);
          send({ type: "user_input", sessionId: msg.session.id, text: t });
        }
        break;
      case "session_closed":
        state.sessions = state.sessions.filter((s) => s.id !== msg.sessionId);
        if (state.current === msg.sessionId) state.current = null;
        renderSessions();
        break;
      case "history":
        if (msg.sessionId === state.current) {
          clearMessages();
          msg.entries.forEach((e) => addMessage(e.channel, e.text));
        }
        break;
      case "worker_message":
        if (msg.sessionId === state.current) addMessage("worker", msg.text);
        break;
      case "persona_message":
        if (msg.sessionId === state.current) addMessage("persona", msg.text, state.personaName);
        break;
      case "session_state":
        updateSessionState(msg.sessionId, msg.state);
        break;
      case "permission_request":
        if (msg.sessionId === state.current) showPermission(msg);
        break;
      case "profile_switched":
        el("profileSelect").value = msg.profile;
        addMessage("system", "已切换 profile → " + msg.profile + "（只影响新开会话）");
        break;
      case "error":
        addMessage("system", "错误: " + msg.message);
        break;
    }
  }

  function fillProfiles(profiles, active) {
    const sel = el("profileSelect");
    sel.innerHTML = "";
    profiles.forEach((p) => {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = p;
      if (p === active) o.selected = true;
      sel.appendChild(o);
    });
  }

  // ── 会话列表 ──────────────────────────────────────────
  function upsertSession(s) {
    const i = state.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) state.sessions[i] = s;
    else state.sessions.unshift(s);
    renderSessions();
  }

  function updateSessionState(id, st) {
    const s = state.sessions.find((x) => x.id === id);
    if (s) {
      s.state = st;
      renderSessions();
    }
  }

  function renderSessions() {
    const ul = el("sessionList");
    ul.innerHTML = "";
    state.sessions.forEach((s) => {
      const li = document.createElement("li");
      if (s.id === state.current) li.className = "active";
      li.innerHTML =
        '<div class="s-name">' +
        escapeHtml(s.name) +
        "</div><div class=\"s-meta\">" +
        s.id +
        " · " +
        s.profile +
        "/" +
        s.engine +
        " · " +
        s.state +
        "</div>";
      li.onclick = () => selectSession(s.id);
      ul.appendChild(li);
    });
  }

  function selectSession(id) {
    state.current = id;
    renderSessions();
    clearMessages();
    send({ type: "get_history", sessionId: id });
  }

  // ── 消息区 ────────────────────────────────────────────
  function clearMessages() {
    el("messages").innerHTML = "";
    hidePermission();
  }

  function addMessage(channel, text, who) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + channel;
    const whoLabel = who || labelOf(channel);
    wrap.innerHTML =
      '<div class="who">' + escapeHtml(whoLabel) + '</div><div class="body">' + escapeHtml(text) + "</div>";
    const box = el("messages");
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  function labelOf(channel) {
    return { user: "我", worker: "工作层", persona: state.personaName, system: "系统" }[channel] || channel;
  }

  // ── 权限 ──────────────────────────────────────────────
  function showPermission(msg) {
    state.pendingPermission = msg;
    el("permText").textContent = "⚠ 工作层请求权限 [" + msg.tool + "]: " + msg.detail;
    el("permission").classList.remove("hidden");
  }
  function hidePermission() {
    state.pendingPermission = null;
    el("permission").classList.add("hidden");
  }
  function answerPermission(approve) {
    const p = state.pendingPermission;
    if (!p) return;
    send({ type: "permission_response", sessionId: p.sessionId, requestId: p.requestId, approve });
    hidePermission();
  }

  // ── 输入与控件 ────────────────────────────────────────
  el("inputForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = el("input");
    const text = input.value.trim();
    if (!text) return;
    if (!state.current) {
      send({ type: "create_session", name: text.slice(0, 20) });
      state.pendingFirstInput = text;
    } else {
      addMessage("user", text);
      send({ type: "user_input", sessionId: state.current, text });
    }
    input.value = "";
  });

  // 新会话创建后，待发首条输入在 session_created 分支处理（见上）。

  el("newBtn").onclick = () => send({ type: "create_session" });
  el("approveBtn").onclick = () => answerPermission(true);
  el("denyBtn").onclick = () => answerPermission(false);
  el("profileSelect").onchange = (e) => send({ type: "switch_profile", profile: e.target.value });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  connect();
})();
