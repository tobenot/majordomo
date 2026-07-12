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

  const HAS_EMOJI_RE = /\p{Emoji_Presentation}|\p{Emoji}️|\p{Extended_Pictographic}(?=\s|$|[#*0-9]️?⃣?)/gu;
  function replaceEmoji(html) {
    if (!HAS_EMOJI_RE.test(html)) return html;
    HAS_EMOJI_RE.lastIndex = 0;
    return html.replace(HAS_EMOJI_RE, function (ch) {
      return '<img class="emoji-img" src="https://emojicdn.elk.sh/' +
        encodeURIComponent(ch) + '?style=google" alt="' + ch + '" />';
    });
  }

  const state = {
    ws: null,
    windows: [], // WindowInfo[]
    todos: [],
    acceptance: [],
    current: null, // 选中的 windowId
    personaName: "中枢",
    assetNames: [],
    personaPending: {}, // windowId -> true（人设层 API 调用中）
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
        if (msg.partial) applyPersonaPartial(msg.windowId, msg.text, msg.thinking);
        else applyPersona(msg.windowId, msg.text, msg.personaMessages);
        break;
      case "window_persona_status":
        setPersonaPending(msg.windowId, msg.phase === "start");
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
    else {
      state.windows.unshift(w);
      if (!state.current) selectWindow(w.windowId);
    }
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
    w.lastThinking = "";
    if (personaMessages) w.personaMessages = personaMessages;
    state.personaPending[id] = false;
    if (state.current === id) renderDetail();
    renderWindows();
  }

  function applyPersonaPartial(id, text, thinking) {
    const w = state.windows.find((x) => x.windowId === id);
    if (!w) return;
    if (thinking) {
      w.lastThinking = text;
      // 只改跑马灯文案，避免整页重渲打断滚动动画
      if (state.current === id) {
        var scroll = document.querySelector("#personaScroll .persona-pending-scroll");
        if (scroll) {
          var line = thinkingLine(text);
          scroll.textContent = line + " · " + line;
          renderWindows();
          return;
        }
      }
    } else {
      w.lastPersona = text;
      w.lastThinking = ""; // 正文开始后收起思考
    }
    // 保持 pending；流式草稿挂在 lastPersona / lastThinking
    if (state.current === id) renderDetail({ keepScroll: true });
    renderWindows();
  }

  function setPersonaPending(id, pending) {
    state.personaPending[id] = !!pending;
    if (pending) {
      const w = state.windows.find((x) => x.windowId === id);
      if (w) {
        w.lastPersona = "";
        w.lastThinking = "";
      }
    }
    renderWindows();
    if (state.current === id) renderDetail();
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
      var hasMissAlert = w.metrics && w.metrics.missPercent > 0.6;
      if (hasMissAlert) li.classList.add("window-alert");
      var pending = !!state.personaPending[w.windowId];
      li.innerHTML =
        '<div class="s-name"><span class="dot ' + w.state + (pending ? " persona-pending" : "") + '"></span>' +
        escapeHtml(w.title) +
        '</div><div class="s-meta">' +
        (pending ? "人设层调用中…" : (STATE_LABEL[w.state] || w.state)) +
        " · " +
        escapeHtml(oneLine(w.lastUserText || w.lastSummary || w.lastText || "", 60)) +
        "</div>" +
        (w.usage ? usageSummary(w.usage) : "") +
        (w.metrics ? metricsSummary(w.metrics) : "");
      li.onclick = () => selectWindow(w.windowId);
      ul.appendChild(li);
    });
  }

  function selectWindow(id) {
    state.current = id;
    state.assetName = pickRandom(state.assetNames) || state.personaName || "";
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
    if (!el || !src) { if (el) { el.classList.remove("loaded"); el.src = ""; } return; }
    el.onload = function () { el.classList.add("loaded"); };
    el.onerror = function () { el.classList.remove("loaded"); el.src = ""; };
    el.src = src;
  }

  function loadImages(windowId) {
    var name = state.assetName || "";
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
    loadImg(el("cgImg"), assetUrl("cg", name));
  }

  function renderDetail(opts) {
    const w = state.windows.find((x) => x.windowId === state.current);
    const pScroll = el("personaScroll");
    const actWrap = el("activityWrap");
    const act = el("activity");
    if (!w) {
      el("detailTitle").textContent = "选一个窗口看它在做什么";
      el("detailState").textContent = "";
      el("detailState").className = "badge";
      if (pScroll) { pScroll.innerHTML = ""; pScroll.scrollTop = 0; }
      actWrap.classList.add("hidden");
      return;
    }
    el("detailTitle").textContent = w.title + "  ·  " + w.cwd;
    const sb = el("detailState");
    var pending = !!state.personaPending[w.windowId];
    if (pending) {
      sb.textContent = "人设层调用中…";
      sb.className = "badge state-persona";
    } else {
      sb.textContent = STATE_LABEL[w.state] || w.state;
      sb.className = "badge state-" + w.state;
    }

    // 人设消息历史（气泡流，最早在上，最新在下）
    var msgs = w.personaMessages || [];
    var pendingBanner = "";
    if (pending) {
      if (w.lastPersona) {
        pendingBanner = '<div class="persona-pending-banner">…人设层生成中</div>';
      } else if (w.lastThinking) {
        var line = thinkingLine(w.lastThinking);
        var scroll = escapeHtml(line) + " · " + escapeHtml(line);
        pendingBanner =
          '<div class="persona-pending-banner persona-pending-marquee">' +
          '<span class="persona-pending-scroll">' + scroll + "</span></div>";
      } else {
        pendingBanner = '<div class="persona-pending-banner">…人设层调用中，等 API 回来</div>';
      }
    }
    // 流式草稿：尚未写入 personaMessages，挂在 lastPersona
    var draftHtml = "";
    if (pending && w.lastPersona) {
      draftHtml =
        '<div class="persona-bubble">' +
        '<div class="persona-bubble-head">' +
        '<span class="persona-who">' + escapeHtml(state.personaName) + '</span>' +
        '<span class="persona-ts">生成中</span>' +
        '</div>' +
        '<div class="persona-bubble-body md">' + replaceEmoji(window.MjMarkdown.render(w.lastPersona)) + '</div>' +
        '</div>';
    }
    if (msgs.length || draftHtml || pendingBanner) {
      var html = '<div class="persona-msgs">' + pendingBanner;
      for (var i = 0; i < msgs.length; i++) {
        var bubbleHtml =
          '<div class="persona-bubble">' +
          '<div class="persona-bubble-head">' +
          '<span class="persona-who">' + escapeHtml(state.personaName) + '</span>' +
          '<span class="persona-ts">' + fmtTime(msgs[i].ts) + '</span>' +
          '</div>' +
          '<div class="persona-bubble-body md">' + replaceEmoji(window.MjMarkdown.render(msgs[i].text)) + '</div>' +
          '</div>';
        if (i === msgs.length - 1 && !draftHtml) {
          html += '<div class="persona-bubble-last">';
          html += '<img class="standing-panel" id="standingPanel" src="" alt="" />';
          html += bubbleHtml;
          html += '</div>';
        } else {
          html += bubbleHtml;
        }
      }
      if (draftHtml) {
        html += '<div class="persona-bubble-last">';
        html += '<img class="standing-panel" id="standingPanel" src="" alt="" />';
        html += draftHtml;
        html += '</div>';
      }
      html += '</div>';
      pScroll.innerHTML = html;
      if (!opts || !opts.keepScroll) pScroll.scrollTop = 0;
      var name = state.assetName || "";
      loadImg(el("standingPanel"), assetUrl("standing", name));
    } else {
      pScroll.innerHTML =
        '<div class="persona-msgs empty">' +
        (pendingBanner || "还没有人设消息") +
        "</div>";
    }

    // 会话度量 + 上下文/token
    el("metricsArea").innerHTML = usageDetail(w.usage) + metricsDetail(w.metrics);

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

  function fmtTokens(n) {
    if (n == null || n === "") return "";
    n = Number(n);
    if (!isFinite(n)) return "";
    if (n >= 1000000) {
      var m = Math.round(n / 100000) / 10;
      return (m % 1 === 0 ? String(Math.round(m)) : String(m)) + "M";
    }
    if (n >= 1000) return Math.round(n / 1000) + "k";
    return String(Math.round(n));
  }

  function usageSummary(u) {
    if (!u) return "";
    var bits = [];
    if (u.usedPercent != null) {
      var line = "context " + Math.round(u.usedPercent) + "%";
      if (u.windowSize) line += " / " + fmtTokens(u.windowSize);
      bits.push(line);
    } else if (u.windowSize) {
      bits.push("窗口 " + fmtTokens(u.windowSize));
    }
    if (u.lastInputTokens != null || u.lastOutputTokens != null) {
      bits.push("本轮 输入 " + fmtTokens(u.lastInputTokens || 0) + " | 输出 " + fmtTokens(u.lastOutputTokens || 0));
    }
    if (u.totalInputTokens != null || u.totalOutputTokens != null) {
      bits.push("累计 输入 " + fmtTokens(u.totalInputTokens || 0) + " | 输出 " + fmtTokens(u.totalOutputTokens || 0));
    }
    if (!bits.length) return "";
    return '<div class="s-metrics s-usage">' + escapeHtml(bits.join(" | ")) + "</div>";
  }

  function usageDetail(u) {
    if (!u) return "";
    var has =
      u.usedPercent != null || u.windowSize ||
      u.lastInputTokens != null || u.lastOutputTokens != null ||
      u.totalInputTokens != null || u.totalOutputTokens != null;
    if (!has) return "";
    return (
      '<div class="metrics-card">' +
      '<div class="metrics-title">上下文 / Token</div>' +
      '<div class="metrics-grid">' +
        (u.usedPercent != null ? metricsKV("context 已用", Math.round(u.usedPercent) + "%") : "") +
        (u.windowSize ? metricsKV("窗口上限", fmtTokens(u.windowSize)) : "") +
        (u.lastInputTokens != null ? metricsKV("本轮输入", fmtTokens(u.lastInputTokens)) : "") +
        (u.lastOutputTokens != null ? metricsKV("本轮输出", fmtTokens(u.lastOutputTokens)) : "") +
        (u.lastCacheReadTokens != null ? metricsKV("本轮缓存命中", fmtTokens(u.lastCacheReadTokens)) : "") +
        (u.totalInputTokens != null ? metricsKV("累计输入", fmtTokens(u.totalInputTokens)) : "") +
        (u.totalOutputTokens != null ? metricsKV("累计输出", fmtTokens(u.totalOutputTokens)) : "") +
      "</div></div>"
    );
  }

  function metricsSummary(m) {
    if (!m || !m.totalRounds) return "";
    var pct = Math.round(m.missPercent * 100);
    var alertClass = m.missPercent > 0.6 ? " metrics-alert" : "";
    return '<div class="s-metrics' + alertClass + '">cache miss ' + pct + '%</div>';
  }

  function metricsDetail(m) {
    if (!m || !m.totalRounds) return "";
    return (
      '<div class="metrics-card' + (m.missPercent > 0.6 ? ' metrics-card-alert' : '') + '">' +
      '<div class="metrics-title">会话度量</div>' +
      '<div class="metrics-grid">' +
        metricsKV('cache miss', Math.round(m.missPercent * 100) + '%') +
        metricsKV('最近段 miss', Math.round(m.lastSegmentMissPercent * 100) + '%') +
        metricsKV('塌方峰值', Math.round(m.maxSingleRoundInput).toLocaleString() + ' token') +
        metricsKV('累计产出', Math.round(m.cumulativeOutputTokens).toLocaleString() + ' token') +
        metricsKV('会话时长', fmtDuration(m.sessionDurationMs)) +
        metricsKV('耗时中位', fmtMs(m.latencyMedianMs)) +
        metricsKV('耗时 p90', fmtMs(m.latencyP90Ms)) +
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
  /** 取思考流最后一行（非空），给横幅跑马灯用。 */
  function thinkingLine(s) {
    var parts = String(s || "").replace(/\r/g, "").split("\n");
    for (var i = parts.length - 1; i >= 0; i--) {
      var t = parts[i].replace(/\s+/g, " ").trim();
      if (t) return t.length > 160 ? t.slice(-160) : t;
    }
    return "";
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
