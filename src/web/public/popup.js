// majordomo 交接浮窗：常驻置顶，订阅中枢 WS。
// 双模式：列表（多窗口一览）/ 详情（单窗口 persona 全文）。
// 新事件不抢焦点——只标记未读 + 更新提示，等你主动翻。
(function () {
  "use strict";

  var HAS_EMOJI_RE = /\p{Emoji_Presentation}|\p{Emoji}️|\p{Extended_Pictographic}(?=\s|$|[#*0-9]️?⃣?)/gu;
  function replaceEmoji(html) {
    if (!HAS_EMOJI_RE.test(html)) return html;
    HAS_EMOJI_RE.lastIndex = 0;
    return html.replace(HAS_EMOJI_RE, function (ch) {
      return '<img class="emoji-img" src="https://emojicdn.elk.sh/' +
        encodeURIComponent(ch) + '?style=google" alt="' + ch + '" />';
    });
  }

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
    current: null,      // 详情模式展示的 windowId
    personaName: "中枢",
    assetNames: [],
    unread: {},         // windowId -> true
    mode: "collapsed",  // 'list' | 'detail' | 'collapsed'
    suppressed: false,  // 用户点了缩小：只留头部条，不响应新事件展开
  };

  var STATE_LABEL = { working: "干活中", waiting: "等你", idle: "空闲", offline: "离线" };

  // ── 快捷面板 ────────────────────────────────────────────
  // ponytail: 预设硬编码，够用；推荐回复从 persona 文本解析
  var PRESET_CHIPS = [
    { label: "/clear", text: "/clear" },
    { label: "commit", text: "commit" },
    { label: "/compact", text: "/compact" },
    { label: "维护文档，commit并push", text: "维护文档，commit并push" },
  ];

  function parseRecommend(text) {
    if (!text) return "";
    var m = text.match(/\[推荐回复\]\s*(.+?)(?:\r?\n|$)/);
    return m ? m[1].trim() : "";
  }

  function renderQuickActions(personaText) {
    var panel = el("quickActions");
    if (!panel) return;
    var html = "";

    // 解析推荐回复
    var rec = parseRecommend(personaText);
    if (rec) {
      html += '<div class="qa-chip qa-rec" data-copy="' + escapeHtml(rec) + '" title="' + escapeHtml(rec) + '">' + escapeHtml(rec) + "</div>";
    }

    // 预设 chip
    PRESET_CHIPS.forEach(function (c) {
      html += '<div class="qa-chip" data-copy="' + escapeHtml(c.text) + '" title="' + escapeHtml(c.text) + '">' + escapeHtml(c.label) + "</div>";
    });

    panel.innerHTML = html;

    // 绑定点击
    panel.querySelectorAll(".qa-chip").forEach(function (chip) {
      chip.addEventListener("click", function (e) {
        e.stopPropagation();
        var text = chip.dataset.copy || "";
        copyChip(chip, text);
      });
    });
  }

  function copyChip(chip, text) {
    var done = function () {
      chip.classList.add("copied");
      chip.textContent = "已复制 ✓";
      setTimeout(function () {
        chip.classList.remove("copied");
        chip.textContent = chip.dataset.copy || "";
      }, 1200);
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
  }

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
        loadPersistentArt();
        break;
      case "hub_snapshot":
        state.windows = {};
        (msg.snapshot.windows || []).forEach(function (w) { state.windows[w.windowId] = w; });
        if (state.suppressed) { renderCollapsed(); return; }
        if (state.mode === "collapsed") showList();
        else render();
        break;
      case "window_update":
        upsert(msg.window);
        break;
      case "window_offline":
        if (state.windows[msg.windowId]) state.windows[msg.windowId].state = "offline";
        if (!state.suppressed) render();
        break;
      case "window_persona": {
        var win = state.windows[msg.windowId];
        if (!win) break;
        var isNewPersona = win.lastPersona !== msg.text;
        win.lastPersona = msg.text;
        if (msg.personaMessages) win.personaMessages = msg.personaMessages;

        if (isNewPersona) {
          state.unread[msg.windowId] = true;
          if (state.suppressed) {
            // 缩小态：只脉冲提示，不展开
            pulse();
            return;
          }
          if (state.mode === "detail" && state.current !== msg.windowId) {
            pulse();
            render();
          } else if (state.mode === "list") {
            showDetail(msg.windowId);
            pulse();
          } else if (state.mode !== "detail") {
            showList();
            pulse();
          } else {
            render();
          }
        } else if (state.mode === "detail" && state.current === msg.windowId) {
          render();
        } else if (state.mode === "list") {
          render();
        }
        break;
      }
    }
  }

  function upsert(w) {
    var prev = state.windows[w.windowId];
    state.windows[w.windowId] = w;

    var isNew = !prev;
    var becameWaiting = w.state === "waiting" && (!prev || prev.state !== "waiting");
    var hasNewPersona = w.lastPersona && (!prev || prev.lastPersona !== w.lastPersona);

    // 需要你介入 或 有新 persona → 标记未读
    if (becameWaiting || hasNewPersona) {
      state.unread[w.windowId] = true;
    }

    // 缩小态：只静默更新数据，不展开
    if (state.suppressed) {
      if (becameWaiting || hasNewPersona) pulse();
      return;
    }

    // 新窗口上线 → 列表模式下自动展开
    if (isNew && state.mode === "list") {
      showDetail(w.windowId);
      pulse();
      return;
    }

    if (becameWaiting || hasNewPersona) {
      // 不抢焦点：如果正在看别的窗口，只脉冲提示，不切走
      if (state.mode === "detail" && state.current !== w.windowId) {
        pulse(); // 轻脉冲提示有新东西
        render(); // 更新头部 +N 标签
        return;
      }
      // 列表模式 → 自动展开新窗口详情；收起态 → 只展开列表
      if (state.mode === "list") {
        showDetail(w.windowId);
        pulse();
        return;
      }
      if (state.mode !== "detail") {
        showList();
        pulse();
        return;
      }
    }

    // 正在看的就是这个窗口 → 刷新详情
    if (state.mode === "detail" && state.current === w.windowId) render();
    else if (state.mode === "list") render();
  }

  // ── 模式切换 ────────────────────────────────────────────
  function showList() {
    state.mode = "list";
    state.current = null;
    toggleNavArrows(false);
    expand();
    render();
  }

  function showDetail(windowId) {
    state.mode = "detail";
    state.current = windowId;
    loadStanding(windowId);
    expand();
    render();
  }

  // ── 立绘 / CG ──────────────────────────────────────────
  // ponytail: 小头像和 peek 用 emoji 替代，不再加载立绘裁切
  function loadPersistentArt() {}

  function loadStanding(windowId) {
    var w = state.windows[windowId];
    var name = pickRandom(state.assetNames) || state.personaName || (w && w.title) || "";

    var sFrame = el("standingFrame");
    var sImg = el("standing");
    var sSrc = assetUrl("standing", name);
    if (sSrc) {
      sImg.onload = function () { sFrame.classList.add("loaded"); };
      sImg.onerror = function () { sFrame.classList.remove("loaded"); sImg.src = ""; };
      sImg.src = sSrc;
    } else {
      sFrame.classList.remove("loaded");
      sImg.src = "";
    }

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
    if (state.mode === "detail") renderDetail();
    else if (state.mode === "list") renderList();
    else renderCollapsed();
  }

  function renderCollapsed() {
    el("proj").textContent = "majordomo";
    el("more").style.display = "none";
    el("time").textContent = "";
    el("listWrap").style.display = "none";
    el("detailWrap").style.display = "none";
    el("card").classList.add("collapsed");
  }

  function renderList() {
    el("card").classList.remove("collapsed");
    el("listWrap").style.display = "";
    el("detailWrap").style.display = "none";

    // 头部：显示项目名和未读计数
    var all = windowList();
    var unreadCount = 0;
    for (var k in state.unread) { if (state.unread.hasOwnProperty(k) && state.unread[k]) unreadCount++; }

    if (all.length > 0) {
      el("proj").textContent = unreadCount > 0 ? ("窗口 (" + unreadCount + " 项更新)") : "窗口";
    } else {
      el("proj").textContent = "majordomo";
    }
    el("more").style.display = "none";
    el("time").textContent = "";

    // 渲染列表卡片
    var list = el("windowList");
    list.innerHTML = "";
    if (all.length === 0) {
      list.innerHTML = '<div class="list-empty">等待窗口交接…</div>';
      return;
    }
    all.forEach(function (w) {
      var unread = !!state.unread[w.windowId];
      var preview = w.lastPersona || w.lastSummary || w.lastText || "";
      var card = document.createElement("div");
      card.className = "win-card" + (unread ? " unread" : "");
      card.onclick = function () { showDetail(w.windowId); };
      var metricsLine = popupMetrics(w.metrics);
      card.innerHTML =
        '<div class="win-card-head">' +
          '<span class="win-card-dot" style="color:' + (unread ? 'var(--honey)' : 'var(--border)') + '">●</span>' +
          '<span class="win-card-title">' + escapeHtml(w.title || "majordomo") + "</span>" +
          '<span class="win-card-time">' + fmtTime(w.updatedAt) + "</span>" +
        "</div>" +
        '<div class="win-card-state">' + (STATE_LABEL[w.state] || w.state) + "</div>" +
        (metricsLine ? '<div class="win-card-metrics">' + escapeHtml(metricsLine) + "</div>" : "") +
        (preview ? '<div class="win-card-preview">' + escapeHtml(preview) + "</div>" : "");
      list.appendChild(card);
    });
  }

  function toggleNavArrows(visible) {
    var list = windowList();
    var show = visible && list.length > 1;
    el("navLeft").classList.toggle("visible", show);
    el("navRight").classList.toggle("visible", show);
  }

  function navWindow(dir) {
    if (state.mode !== "detail") return;
    var list = windowList();
    if (list.length < 2) return;
    var idx = -1;
    for (var i = 0; i < list.length; i++) { if (list[i].windowId === state.current) { idx = i; break; } }
    if (idx < 0) return;
    var next = dir === -1 ? idx - 1 : idx + 1;
    if (next < 0) next = list.length - 1;
    if (next >= list.length) next = 0;
    showDetail(list[next].windowId);
  }

  function renderDetail() {
    el("card").classList.remove("collapsed");
    el("listWrap").style.display = "none";
    el("detailWrap").style.display = "";

    var w = state.windows[state.current];
    if (!w) { showList(); return; }

    el("proj").textContent = (w.title || "majordomo");
    el("proj").title = w.cwd || "";
    toggleNavArrows(true);
    el("time").textContent = fmtTime(w.updatedAt) + " · " + (STATE_LABEL[w.state] || w.state);
    el("who").textContent = state.personaName;

    // 未读辉光
    el("card").classList.toggle("unread", !!state.unread[state.current]);

    var text = w.lastPersona || w.lastText || "";
    el("persona").innerHTML = text ? replaceEmoji(window.MjMarkdown.render(text)) : '<span class="empty">（暂无交接文本）</span>';

    // 立绘下方快捷面板
    renderQuickActions(text);

    // 会话度量（简短行内版）
    var m = popupMetrics(w.metrics);
    el("detailMetrics").textContent = m || "";
    el("detailMetrics").style.display = m ? "" : "none";

    // 活动流
    var actsBody = el("acts");
    actsBody.innerHTML = "";
    var acts = (w.activity || []).slice().reverse().slice(0, 12);
    acts.forEach(function (a) {
      var row = document.createElement("div");
      row.className = "act-row";
      row.innerHTML =
        '<span class="act-ts">' + fmtTime(a.ts) + "</span>" +
        '<span class="act-ev ev-' + escapeAttr(a.event) + '">' + escapeHtml(a.event) + "</span>" +
        '<span class="act-sum">' + escapeHtml(a.summary) + "</span>";
      actsBody.appendChild(row);
    });
    el("actCount").textContent = acts.length > 0 ? "(" + acts.length + ")" : "";

    // 首次渲染默认折叠活动区
    if (!el("actsWrap").dataset.inited) {
      el("actsWrap").classList.add("collapsed");
      el("actsWrap").dataset.inited = "1";
    }
    var collapsed = el("actsWrap").classList.contains("collapsed");
    el("actsToggle").textContent = (collapsed ? "▶" : "▼") + " 本轮活动" + actCountLabel();

    // 未读计数标签
    renderMore();

    // 切窗口后滚回顶部（rAF 等布局完成，否则 scrollTop=0 会被后续重排冲掉）
    requestAnimationFrame(function () {
      el("personaWrap").scrollTop = 0;
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
  }

  function renderMore() {
    var chip = el("more");
    if (!chip) return;
    var others = 0;
    for (var k in state.unread) {
      if (state.unread.hasOwnProperty(k) && state.unread[k] && k !== state.current) others++;
    }
    if (others > 0) {
      chip.textContent = "+" + others;
      chip.title = "还有 " + others + " 个窗口等你，点击返回列表";
      chip.style.display = "";
      chip.onclick = showList;
    } else {
      chip.style.display = "none";
    }
  }

  function windowList() {
    var arr = [];
    for (var k in state.windows) if (state.windows.hasOwnProperty(k)) arr.push(state.windows[k]);
    arr = arr.filter(function (w) { return w.state !== "offline"; });
    arr.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    return arr;
  }

  // ── 按钮 ────────────────────────────────────────────────
  // 缩小/恢复：抑制时只留头部条，新事件不抢焦点。再点恢复。
  el("btnMin").onclick = function () {
    if (state.suppressed) {
      restorePopup();
    } else {
      state.suppressed = true;
      state.mode = "collapsed";
      send({ type: "popup_suppress" });
      renderCollapsed();
      el("btnMin").textContent = "+";
      el("btnMin").title = "恢复弹窗";
    }
  };

  function restorePopup() {
    state.suppressed = false;
    send({ type: "popup_restore" });
    el("btnMin").textContent = "−";
    el("btnMin").title = "缩小弹窗（不再自动弹出）";
    showList();
  }

  // "知道了"：清除当前未读 → 回列表
  el("btnOk").onclick = function () {
    delete state.unread[state.current];
    el("card").classList.remove("unread");
    showList();
  };

  // "返回列表"按钮
  el("btnList").onclick = showList;

  // 活动折叠
  el("actsToggle").onclick = function () {
    el("actsWrap").classList.toggle("collapsed");
    var collapsed = el("actsWrap").classList.contains("collapsed");
    el("actsToggle").textContent = (collapsed ? "▶" : "▼") + " 本轮活动" + actCountLabel();
  };

  function actCountLabel() {
    var w = state.windows[state.current];
    var n = (w && w.activity ? w.activity.length : 0);
    return n > 0 ? " (" + n + ")" : "";
  }

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

  function currentPlainText() {
    var w = state.windows[state.current];
    if (!w) return "";
    return w.lastPersona || w.lastText || "";
  }

  // 左右方向键导航窗口
  document.addEventListener("keydown", function (e) {
    if (state.mode !== "detail") return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); navWindow(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); navWindow(1); }
  });

  // 导航箭头点击
  el("navLeft").onclick = function () { navWindow(-1); };
  el("navRight").onclick = function () { navWindow(1); };

  // 双击头部：缩小态恢复，详情态回列表
  el("head").addEventListener("dblclick", function () {
    if (state.suppressed) { restorePopup(); return; }
    if (state.mode === "detail") showList();
    else if (state.mode === "list" && state.current) showDetail(state.current);
  });

  // ── 视觉提示 ────────────────────────────────────────────
  function pulse() {
    var card = el("card");
    card.classList.remove("pulse");
    void card.offsetWidth;
    card.classList.add("pulse");
  }
  function expand() { el("card").classList.remove("collapsed"); }

  // ── 工具 ────────────────────────────────────────────────
  function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function popupMetrics(m) {
    if (!m || !m.totalRounds) return "";
    var pct = Math.round(m.missPercent * 100);
    var slow = Math.round(m.latencyMaxMs / 1000);
    return "miss " + pct + "% · " + m.totalRounds + "轮 · 慢峰" + slow + "s";
  }

  function escapeAttr(s) { return escapeHtml(s).replace(/[^a-zA-Z0-9_-]/g, "_"); }

  connect();
})();
