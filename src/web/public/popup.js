// majordomo 交接浮窗：常驻置顶，订阅中枢 WS。任一窗口交接（stop 有 persona / notification）
// 时把浮窗刷成"最新交接"，脉冲 + 留一道"未读"呼吸辉光直到你点知道了。同源 WS = daemon
// 自身端口（popup 页由 daemon 直供）。提示音由 notify-done（PS）独占，浮窗不出声——
// Edge app 全新 user-data-dir 无用户手势，WebAudio 必被 autoplay 拦，出声看运气反成噪音。
(function () {
  "use strict";

  var WS_URL = resolveWsUrl(window.__WS_URL__);
  var el = function (id) { return document.getElementById(id); };

  function resolveWsUrl(raw) {
    var protocol = window.location.protocol === "https:" ? "wss://" : "ws://";
    raw = String(raw);
    if (raw.indexOf("__AUTO_WS__:") === 0) {
      var port = raw.split(":")[1];
      return protocol + window.location.hostname + ":" + port;
    }
    if (window.location.protocol === "https:" && raw.indexOf("ws://") === 0) {
      return "wss://" + raw.slice(5);
    }
    return raw;
  }

  var state = {
    ws: null,
    windows: {},        // windowId -> WindowInfo
    current: null,      // 当前展示的 windowId
    personaName: "中枢",
    assetNames: [],
    unread: {},         // windowId -> true：交接来了但还没点"知道了"
  };

  var STATE_LABEL = { working: "干活中", waiting: "等你", idle: "空闲", offline: "离线" };

  // ── 连接 ────────────────────────────────────────────────
  function connect() {
    var ws;
    try { ws = new WebSocket(WS_URL); } catch (e) { setConn(false); setTimeout(connect, 2000); return; }
    state.ws = ws;
    ws.onopen = function () { setConn(true); send({ type: "hello", client: "web" }); };
    ws.onclose = function () { setConn(false); setTimeout(connect, 2000); };
    ws.onerror = function () { setConn(false); };
    ws.onmessage = function (e) { try { onMessage(JSON.parse(e.data)); } catch (err) { /* ignore */ } };
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
  }

  function setConn(ok) {
    var c = el("conn");
    c.className = "conn " + (ok ? "on" : "off");
    c.title = ok ? "已连中枢" : "与中枢断开，重连中…";
  }

  // ── 消息处理 ────────────────────────────────────────────
  function onMessage(msg) {
    switch (msg.type) {
      case "welcome":
        state.personaName = msg.personaName || "中枢";
        state.assetNames = msg.assetNames || [];
        break;
      case "hub_snapshot":
        state.windows = {};
        (msg.snapshot.windows || []).forEach(function (w) { state.windows[w.windowId] = w; });
        // 首次连上：展示最近活跃且有内容的窗口，但不脉冲/响铃（不是新事件）
        var latest = latestInteresting();
        if (latest) { state.current = latest.windowId; render(); }
        break;
      case "window_update":
        upsert(msg.window);
        break;
      case "window_offline":
        if (state.windows[msg.windowId]) state.windows[msg.windowId].state = "offline";
        if (state.current === msg.windowId) render();
        break;
      case "window_persona":
        // 交接文本到位 = 一次真正的"交接"，切到该窗口 + 脉冲 + 响铃
        if (state.windows[msg.windowId]) state.windows[msg.windowId].lastPersona = msg.text;
        focus(msg.windowId, true);
        break;
    }
  }

  function upsert(w) {
    var prev = state.windows[w.windowId];
    state.windows[w.windowId] = w;
    // 窗口转入"等你"（notification）是需要你介入的信号：切过去提醒
    var becameWaiting = w.state === "waiting" && (!prev || prev.state !== "waiting");
    if (becameWaiting) { focus(w.windowId, true); return; }
    if (state.current === w.windowId) render();
  }

  function latestInteresting() {
    var arr = [];
    for (var k in state.windows) if (state.windows.hasOwnProperty(k)) arr.push(state.windows[k]);
    arr = arr.filter(function (w) { return w.state !== "offline"; });
    arr.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    return arr[0] || null;
  }

  // 把某窗口设为当前并渲染；alert=true 则脉冲 + 展开 + 标记未读（声音由 PS 独占）
  function focus(windowId, alert) {
    state.current = windowId;
    if (alert) state.unread[windowId] = true;
    render();
    loadStanding(windowId);
    if (alert) {
      expand();
      pulse();
    }
  }

  // ── 立绘 / CG ──────────────────────────────────────────
  function loadStanding(windowId) {
    var w = state.windows[windowId];
    var name = pickRandom(state.assetNames) || state.personaName || (w && w.title) || "";

    // 立绘
    var sImg = el("standing");
    var sSrc = assetUrl("standing", name);
    loadImg(sImg, sSrc);

    // CG 横幅
    var cBanner = el("cgBanner");
    var cImg = el("cgBannerImg");
    var cSrc = assetUrl("cg", name);
    if (cSrc) {
      cImg.onload = function () { cBanner.classList.add("show"); };
      cImg.onerror = function () { cBanner.classList.remove("show"); cImg.src = ""; };
      cImg.src = cSrc;
    } else {
      cBanner.classList.remove("show");
      cImg.src = "";
    }
  }

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

  // ── 渲染 ────────────────────────────────────────────────
  function render() {
    var w = state.windows[state.current];
    if (!w) {
      el("proj").textContent = "majordomo";
      el("persona").innerHTML = '<span class="empty">等待窗口交接…</span>';
      el("acts").innerHTML = "";
      el("time").textContent = "";
      renderMore();
      return;
    }
    el("proj").textContent = w.title || "majordomo";
    el("proj").title = w.cwd || "";
    el("time").textContent = fmtTime(w.updatedAt) + " · " + (STATE_LABEL[w.state] || w.state);
    el("who").textContent = state.personaName;

    // 未读呼吸辉光：交接来了但没点"知道了"就一直亮，被动置顶窗口需要一个不消失的信号
    el("card").classList.toggle("unread", !!state.unread[state.current]);

    var text = w.lastPersona || w.lastText || "";
    el("persona").innerHTML = text ? window.MjMarkdown.render(text) : '<span class="empty">（暂无交接文本）</span>';

    var acts = el("acts");
    acts.innerHTML = "";
    (w.activity || []).slice().reverse().slice(0, 12).forEach(function (a) {
      var row = document.createElement("div");
      row.className = "act-row";
      row.innerHTML =
        '<span class="act-ts">' + fmtTime(a.ts) + "</span>" +
        '<span class="act-ev ev-' + escapeAttr(a.event) + '">' + escapeHtml(a.event) + "</span>" +
        '<span class="act-sum">' + escapeHtml(a.summary) + "</span>";
      acts.appendChild(row);
    });
    renderMore();
  }

  // 头部"还有 N 个窗口等你"：多窗口同时交接时，只显最新那个会把其余的从视野抹掉。
  // 统计除当前外仍未读的窗口数，点它轮换到下一个未读窗口。
  function renderMore() {
    var chip = el("more");
    if (!chip) return;
    var others = 0;
    for (var k in state.unread) {
      if (state.unread.hasOwnProperty(k) && state.unread[k] && k !== state.current) others++;
    }
    if (others > 0) {
      chip.textContent = "+" + others;
      chip.title = "还有 " + others + " 个窗口等你，点击切换";
      chip.style.display = "";
    } else {
      chip.style.display = "none";
    }
  }

  // 轮换到下一个未读窗口（按更新时间，环形）
  function cycleUnread() {
    var ids = [];
    for (var k in state.unread) {
      if (state.unread.hasOwnProperty(k) && state.unread[k] && k !== state.current && state.windows[k]) ids.push(k);
    }
    if (!ids.length) return;
    ids.sort(function (a, b) { return state.windows[b].updatedAt - state.windows[a].updatedAt; });
    focus(ids[0], false);
    expand();
  }

  function currentPlainText() {
    var w = state.windows[state.current];
    if (!w) return "";
    return w.lastPersona || w.lastText || "";
  }

  // ── 视觉/听觉提示 ───────────────────────────────────────
  function pulse() {
    var card = el("card");
    card.classList.remove("pulse");
    void card.offsetWidth; // 重置动画
    card.classList.add("pulse");
  }
  function expand() { el("card").classList.remove("collapsed"); }
  function collapse() { el("card").classList.add("collapsed"); }

  // ── 工具 ────────────────────────────────────────────────
  function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/[^a-zA-Z0-9_-]/g, "_"); }

  // ── 按钮 ────────────────────────────────────────────────
  // "知道了"：清掉当前窗口未读 → 熄辉光。若还有别的窗口未读就轮换过去，否则收起待命。
  el("btnOk").onclick = function () {
    delete state.unread[state.current];
    var pending = 0;
    for (var k in state.unread) { if (state.unread.hasOwnProperty(k) && state.unread[k]) pending++; }
    if (pending > 0) { cycleUnread(); }
    else { el("card").classList.remove("unread"); collapse(); }
    render();
  };
  el("more").onclick = cycleUnread;
  el("btnCopy").onclick = function () {
    var text = currentPlainText();
    var done = function () {
      var b = el("btnCopy");
      b.textContent = "已复制"; b.classList.add("copied");
      setTimeout(function () { b.textContent = "复制"; b.classList.remove("copied"); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {});
    } else {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta); done();
      } catch (e) { /* ignore */ }
    }
  };
  // 双击头部展开/收起
  el("head").addEventListener("dblclick", function () {
    el("card").classList.toggle("collapsed");
  });

  connect();
})();
