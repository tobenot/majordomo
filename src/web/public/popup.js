// majordomo 交接浮窗：常驻置顶，订阅中枢 WS。任一窗口交接（stop 有 persona / notification）
// 时把浮窗刷成"最新交接"，脉冲 + 提示音。同源 WS = daemon 自身端口（popup 页由 daemon 直供）。
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
    muteUntil: 0,       // 静音截止时间戳
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

  // 把某窗口设为当前并渲染；alert=true 则脉冲 + 展开 + 响铃（除非静音）
  function focus(windowId, alert) {
    state.current = windowId;
    render();
    if (alert) {
      expand();
      pulse();
      if (Date.now() >= state.muteUntil) chime();
    }
  }

  // ── 渲染 ────────────────────────────────────────────────
  function render() {
    var w = state.windows[state.current];
    if (!w) {
      el("proj").textContent = "majordomo";
      el("persona").innerHTML = '<span class="empty">等待窗口交接…</span>';
      el("acts").innerHTML = "";
      el("time").textContent = "";
      return;
    }
    el("proj").textContent = w.title || "majordomo";
    el("proj").title = w.cwd || "";
    el("time").textContent = fmtTime(w.updatedAt) + " · " + (STATE_LABEL[w.state] || w.state);
    el("who").textContent = state.personaName;

    var text = w.lastPersona || w.lastText || "";
    el("persona").innerHTML = text ? renderMarkdown(text) : '<span class="empty">（暂无交接文本）</span>';

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

  // 轻提示音：WebAudio 合成，不依赖资源文件。被 autoplay 策略拦截也无妨（还有 PS 声音兜底）。
  function chime() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var notes = [784, 988]; // G5, B5
      notes.forEach(function (f, i) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = "sine"; o.frequency.value = f;
        o.connect(g); g.connect(ctx.destination);
        var t = ctx.currentTime + i * 0.14;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.start(t); o.stop(t + 0.24);
      });
      setTimeout(function () { try { ctx.close(); } catch (e) {} }, 800);
    } catch (e) { /* best-effort */ }
  }

  // ── 极简 markdown 渲染（先转义，再解析。无第三方依赖） ──
  // 用不可打印哨兵  占位保护行内码，杜绝与正文数字撞车。
  var SENT = String.fromCharCode(1);
  function renderMarkdown(src) {
    var s = escapeHtml(src); // 1) 整体 HTML 转义，杜绝注入
    var out = [];
    var lines = s.split(/\r?\n/);
    var i = 0;
    var listType = null; // "ul" | "ol" | null

    function closeList() { if (listType) { out.push("</" + listType + ">"); listType = null; } }

    while (i < lines.length) {
      var line = lines[i];

      // 代码块 ```
      var fence = line.match(/^\s*```(.*)$/);
      if (fence) {
        closeList();
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过收尾 ```
        out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
        continue;
      }

      // 标题 #/##/###
      var h = line.match(/^\s*(#{1,3})\s+(.*)$/);
      if (h) {
        closeList();
        var lvl = h[1].length;
        out.push("<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">");
        i++; continue;
      }

      // 无序列表 - / *
      var ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ul) {
        if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
        out.push("<li>" + inline(ul[1]) + "</li>");
        i++; continue;
      }

      // 有序列表 1.
      var ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) {
        if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
        out.push("<li>" + inline(ol[1]) + "</li>");
        i++; continue;
      }

      // 空行 → 段落分隔
      if (/^\s*$/.test(line)) { closeList(); i++; continue; }

      // 普通段落（相邻非空行并进一个 <p>，行内换行用 <br>）
      closeList();
      var para = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^\s*(#{1,3}\s|[-*]\s|\d+\.\s|```)/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push("<p>" + para.map(inline).join("<br>") + "</p>");
    }
    closeList();
    return out.join("");
  }

  // 行内：`code` **bold** *italic* [text](url)。输入已 HTML 转义过。
  function inline(s) {
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return SENT + (codes.length - 1) + SENT;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    // 链接 [text](http…)：url 已转义，只允许 http/https，杜绝 javascript:
    s = s.replace(/\[([^\]]+)\]\((https?:&#x2F;&#x2F;[^\s)]+|https?:\/\/[^\s)]+)\)/g, function (_, t, u) {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>";
    });
    s = s.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), function (_, n) {
      return "<code>" + codes[+n] + "</code>";
    });
    return s;
  }

  // ── 工具 ────────────────────────────────────────────────
  function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/[^a-zA-Z0-9_-]/g, "_"); }

  // ── 按钮 ────────────────────────────────────────────────
  el("btnOk").onclick = function () { collapse(); };
  el("btnMute").onclick = function () {
    state.muteUntil = Date.now() + 10 * 60 * 1000;
    var b = el("btnMute");
    b.textContent = "已静音";
    setTimeout(function () { b.textContent = "静音 10 分钟"; }, 1500);
  };
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
