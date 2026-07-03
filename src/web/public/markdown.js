// 极简 markdown 渲染，无第三方依赖。浮窗与中枢面板共用同一份，避免两处各写一遍。
// 安全模型：先整体 HTML 转义再解析，行内码用不可打印哨兵占位（防与正文数字撞车），
// 链接只放行 http/https（杜绝 javascript:）。挂到 window.MjMarkdown。
(function () {
  "use strict";

  var SENT = String.fromCharCode(1);

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render(src) {
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

  window.MjMarkdown = { render: render, escapeHtml: escapeHtml };
})();
