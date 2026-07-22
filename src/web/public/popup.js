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
    personaPending: {}, // windowId -> true
    mode: "collapsed",  // 'list' | 'detail' | 'chat' | 'collapsed'
    modeBeforeChat: "list", // 聊天视图退出后回到哪
    suppressed: false,  // 用户点了缩小：只留头部条，不响应新事件展开
    chatLogs: {},        // windowId -> [{ role: 'user'|'persona', text, pending? }] — 跟后端按窗口分开的历史对齐，只是本次浮窗打开期间的展示，不做持久化
    chatWindowId: "_global", // 当前聊天挂在哪个窗口：详情视图打开的项目窗口，否则虚拟全局
    chatPending: false,  // 上一句还没收到完整回复前不让连发，避免后端历史被并发请求打乱
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
        // 流式中间帧：保持 pending，只刷正文/思考，不抢未读/不弹窗
        if (msg.partial) {
          if (msg.thinking) {
            win.lastThinking = msg.text;
            // 只改跑马灯文案，避免整页重渲打断滚动
            var scrollEl = document.querySelector("#persona .persona-pending-scroll");
            if (scrollEl && state.mode === "detail" && state.current === msg.windowId) {
              var thinkLine = thinkingLine(msg.text);
              scrollEl.textContent = thinkLine + " · " + thinkLine;
              break;
            }
          } else {
            win.lastPersona = msg.text;
            win.lastThinking = "";
          }
          if (!state.suppressed) render({ keepScroll: true });
          break;
        }
        win.lastPersona = msg.text;
        win.lastThinking = "";
        var isNewPersona = true;
        if (msg.personaMessages) win.personaMessages = msg.personaMessages;
        state.personaPending[msg.windowId] = false;

        if (isNewPersona) {
          state.unread[msg.windowId] = true;
          if (state.suppressed) {
            // 缩小态：只脉冲提示，不展开
            pulse();
            return;
          }
          if (state.mode === "chat") {
            // 聊天中：别的窗口来消息不许把聊天顶掉，只脉冲提示
            if (state.chatWindowId !== msg.windowId) pulse();
            break;
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
      case "window_persona_status":
        state.personaPending[msg.windowId] = msg.phase === "start";
        if (msg.phase === "start" && state.windows[msg.windowId]) {
          state.windows[msg.windowId].lastPersona = "";
          state.windows[msg.windowId].lastThinking = "";
        }
        if (state.suppressed) {
          // 缩小态不抢展开，只脉冲提示还在等人设
          if (msg.phase === "start") pulse();
          break;
        }
        if (msg.phase !== "start") {
          render();
          break;
        }
        // collapsed/list：展开详情露出「调用中」横幅（原先 collapsed 啥也不显）
        if (state.mode === "collapsed" || state.mode === "list") {
          showDetail(msg.windowId);
          pulse();
        } else if (state.current !== msg.windowId) {
          pulse();
          render();
        } else {
          render();
        }
        break;
      case "persona_chat_reply": {
        var log = state.chatLogs[msg.windowId];
        if (!log) break; // 没发过消息给这个窗口，忽略（不会发生，防御一下）
        var last = log[log.length - 1];
        if (last && last.role === "persona" && last.pending) {
          last.text = msg.text;
          last.pending = !!msg.partial;
        } else {
          log.push({ role: "persona", text: msg.text, pending: !!msg.partial });
        }
        if (!msg.partial) state.chatPending = false;
        if (state.mode === "chat" && state.chatWindowId === msg.windowId) renderChat();
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
      if (state.mode === "chat") {
        // 聊天中：别的窗口来消息不许把聊天顶掉，只脉冲提示
        if (state.chatWindowId !== w.windowId) pulse();
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

  function showChat() {
    if (state.mode !== "chat") state.modeBeforeChat = state.mode === "collapsed" ? "list" : state.mode;
    // 详情视图里点聊天 → 挂到该项目窗口；否则挂虚拟全局窗口
    state.chatWindowId = (state.modeBeforeChat === "detail" && state.current) ? state.current : "_global";
    if (!state.chatLogs[state.chatWindowId]) state.chatLogs[state.chatWindowId] = [];
    state.mode = "chat";
    toggleNavArrows(false);
    expand();
    render();
    setTimeout(function () { var i = el("chatInput"); if (i) i.focus(); }, 0);
  }

  function hideChat() {
    state.mode = state.modeBeforeChat || "list";
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
  function render(opts) {
    if (state.mode === "detail") renderDetail(opts);
    else if (state.mode === "list") renderList();
    else if (state.mode === "chat") renderChat(opts);
    else renderCollapsed();
  }

  function renderCollapsed() {
    var unreadCount = 0;
    for (var k in state.unread) { if (state.unread.hasOwnProperty(k) && state.unread[k]) unreadCount++; }

    if (state.suppressed) {
      // 缩小态徽章：人设名 + 未读指示
      el("badgeName").textContent = state.personaName;
      var dot = el("badgeDot");
      if (unreadCount > 0) { dot.classList.add("unread"); dot.title = unreadCount + " 项更新"; }
      else { dot.classList.remove("unread"); dot.title = ""; }
      el("card").classList.add("suppressed");
      el("card").classList.remove("collapsed");
      return;
    }

    // 普通收起态（初始闪屏期）
    el("card").classList.remove("suppressed");
    el("proj").textContent = "majordomo";
    el("more").style.display = "none";
    el("time").textContent = "";
    el("listWrap").style.display = "none";
    el("detailWrap").style.display = "none";
    el("chatWrap").style.display = "none";
    el("card").classList.add("collapsed");
  }

  function renderList() {
    el("card").classList.remove("collapsed");
    el("listWrap").style.display = "";
    el("detailWrap").style.display = "none";
    el("chatWrap").style.display = "none";

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
      var pending = !!state.personaPending[w.windowId];
      var preview = pending
        ? "…人设层调用中"
        : (w.lastPersona || w.lastSummary || w.lastText || "");
      var card = document.createElement("div");
      card.className = "win-card" + (unread ? " unread" : "") + (pending ? " persona-pending" : "");
      card.onclick = function () { showDetail(w.windowId); };
      var metricsLine = popupUsage(w.usage);
      var missLine = popupMetrics(w.metrics);
      var extra = [metricsLine, missLine].filter(Boolean).join(" | ");
      card.innerHTML =
        '<div class="win-card-head">' +
          '<span class="win-card-dot" style="color:' + (pending ? 'var(--accent2)' : unread ? 'var(--honey)' : 'var(--border)') + '">●</span>' +
          '<span class="win-card-title">' + escapeHtml(w.title || "majordomo") + "</span>" +
          '<span class="win-card-time">' + fmtTime(w.updatedAt) + "</span>" +
        "</div>" +
        '<div class="win-card-state">' + (pending ? "人设层调用中…" : (STATE_LABEL[w.state] || w.state)) + "</div>" +
        (extra ? '<div class="win-card-metrics">' + escapeHtml(extra) + "</div>" : "") +
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

  function renderDetail(opts) {
    el("card").classList.remove("collapsed");
    el("listWrap").style.display = "none";
    el("detailWrap").style.display = "";
    el("chatWrap").style.display = "none";

    var w = state.windows[state.current];
    if (!w) { showList(); return; }

    el("proj").textContent = (w.title || "majordomo");
    el("proj").title = w.cwd || "";
    toggleNavArrows(true);
    var pending = !!state.personaPending[w.windowId];
    el("time").textContent = fmtTime(w.updatedAt) + " · " + (pending ? "人设层调用中…" : (STATE_LABEL[w.state] || w.state));
    el("who").textContent = state.personaName;

    // 未读辉光
    el("card").classList.toggle("unread", !!state.unread[state.current]);
    el("card").classList.toggle("persona-pending", pending);

    var draft = w.lastPersona || "";
    var text = draft || w.lastText || "";
    var banner = "";
    if (pending) {
      // 跑马灯只看流式草稿 draft；别用 lastText（停顿前的旧正文会挡住思考）
      if (draft) {
        banner = '<div class="persona-pending-banner">…人设层生成中</div>';
      } else if (w.lastThinking) {
        var line = thinkingLine(w.lastThinking);
        var scrollTxt = escapeHtml(line) + " · " + escapeHtml(line);
        banner =
          '<div class="persona-pending-banner persona-pending-marquee">' +
          '<span class="persona-pending-scroll">' + scrollTxt + "</span></div>";
      } else {
        banner = '<div class="persona-pending-banner">…人设层调用中，等 API 回来</div>';
      }
    }
    if (pending) {
      el("persona").innerHTML =
        banner + (draft ? replaceEmoji(window.MjMarkdown.render(draft)) : "");
    } else {
      el("persona").innerHTML = text ? replaceEmoji(window.MjMarkdown.render(text)) : '<span class="empty">（暂无交接文本）</span>';
    }

    // 流式刷新时别把滚动条拽回顶；首屏/终稿再归零
    if (!opts || !opts.keepScroll) {
      el("personaWrap").scrollTop = 0;
    }

    // 立绘下方快捷面板
    renderQuickActions(text);

    // 会话度量（简短行内版）
    var m = [popupUsage(w.usage), popupMetrics(w.metrics)].filter(Boolean).join(" | ");
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
    // 流式 keepScroll 时跳过，否则每帧把你拽回顶
    if (!opts || !opts.keepScroll) {
      requestAnimationFrame(function () {
        el("personaWrap").scrollTop = 0;
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      });
    }
  }

  // 聊天视图：跟 detail 平行，独立渲染，不碰 window_persona 的任何状态
  function renderChat() {
    el("card").classList.remove("collapsed");
    el("listWrap").style.display = "none";
    el("detailWrap").style.display = "none";
    el("chatWrap").style.display = "";
    var w = state.windows[state.chatWindowId];
    el("proj").textContent = w ? ("跟" + state.personaName + "聊 · " + (w.title || "")) : ("跟" + state.personaName + "聊聊");
    el("time").textContent = "";

    var messages = state.chatLogs[state.chatWindowId] || [];
    var logEl = el("chatLog");
    var nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.innerHTML = messages.map(function (m) {
      var cls = m.role === "user" ? "chat-msg chat-user" : "chat-msg chat-persona";
      var text = m.text ? replaceEmoji(window.MjMarkdown.render(m.text)) : "";
      return '<div class="' + cls + '">' + text + (m.pending ? '<span class="chat-typing">…</span>' : "") + "</div>";
    }).join("");
    // 只有本来就在底部才自动跟到新消息，往上翻看历史时不打扰
    if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
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
  // 缩小徽章：点击恢复
  el("suppressedBadge").onclick = function () { restorePopup(); };

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

  // 聊天入口/退出
  el("btnChat").onclick = function () {
    if (state.mode === "chat") hideChat();
    else showChat();
  };
  el("chatForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (state.chatPending) return; // 上一句还没回来，等它——避免后端历史被并发请求打乱
    var input = el("chatInput");
    var text = (input.value || "").trim();
    if (!text) return;
    input.value = "";
    var windowId = state.chatWindowId;
    var log = state.chatLogs[windowId] || (state.chatLogs[windowId] = []);
    log.push({ role: "user", text: text });
    log.push({ role: "persona", text: "", pending: true });
    state.chatPending = true;
    renderChat();
    send({ type: "persona_chat", windowId: windowId, text: text });
  });

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

  // 左右方向键导航窗口；聊天模式下 Esc 退出
  document.addEventListener("keydown", function (e) {
    if (state.mode === "chat") {
      if (e.key === "Escape") { e.preventDefault(); hideChat(); }
      return;
    }
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
  function expand() { el("card").classList.remove("collapsed", "suppressed"); }

  // ── 工具 ────────────────────────────────────────────────
  function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
  function thinkingLine(s) {
    var parts = String(s || "").replace(/\r/g, "").split("\n");
    for (var i = parts.length - 1; i >= 0; i--) {
      var t = parts[i].replace(/\s+/g, " ").trim();
      if (t) return t.length > 160 ? t.slice(-160) : t;
    }
    return "";
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function popupFmtTokens(n) {
    if (n == null) return "";
    n = Number(n);
    if (!isFinite(n)) return "";
    if (n >= 1000000) {
      var m = Math.round(n / 100000) / 10;
      return (m % 1 === 0 ? String(Math.round(m)) : String(m)) + "M";
    }
    if (n >= 1000) return Math.round(n / 1000) + "k";
    return String(Math.round(n));
  }
  function popupUsage(u) {
    if (!u) return "";
    var bits = [];
    if (u.usedPercent != null) {
      var s = "context " + Math.round(u.usedPercent) + "%";
      if (u.windowSize) s += " / " + popupFmtTokens(u.windowSize);
      bits.push(s);
    }
    if (u.lastInputTokens != null || u.lastOutputTokens != null) {
      bits.push("本轮 输入 " + popupFmtTokens(u.lastInputTokens || 0) + " | 输出 " + popupFmtTokens(u.lastOutputTokens || 0));
    }
    if (u.totalInputTokens != null || u.totalOutputTokens != null) {
      bits.push("累计 输入 " + popupFmtTokens(u.totalInputTokens || 0) + " | 输出 " + popupFmtTokens(u.totalOutputTokens || 0));
    }
    return bits.join(" | ");
  }
  function popupMetrics(m) {
    if (!m || !m.totalRounds) return "";
    var pct = Math.round(m.missPercent * 100);
    return "cache miss " + pct + "%";
  }

  function escapeAttr(s) { return escapeHtml(s).replace(/[^a-zA-Z0-9_-]/g, "_"); }

  connect();
})();
