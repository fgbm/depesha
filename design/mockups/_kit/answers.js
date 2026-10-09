/* mockup-kit: ответы и заметки в макете. Вставляется скриптом scripts/mockup-kit.mjs; описание — design/mockups/README.md. */
(function () {
  "use strict";
  var doc = document;
  var FILE = decodeURIComponent(location.pathname.split("/").pop() || "mockup");
  var KEY = "mockup-kit:" + FILE;
  var TOGGLE_CODE = "Backquote"; // клавиша ` (на русской раскладке — ё); в макетах 0.8.0 не занята
  var RU_BY_CODE = { KeyF: "А", Comma: "Б", KeyD: "В", KeyU: "Г" }; // буквы А/Б/В/Г при латинской раскладке

  function $(s, r) { return (r || doc).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); }
  function h(tag, attrs, text) {
    var e = doc.createElement(tag);
    e.setAttribute("data-mk", "");
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function oneLine(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
  function typing(t) { return !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); }
  function inLive(t) { return !!(t && t.closest && !t.closest("[data-mk]") && t.closest(".stage, [tabindex]")); }

  // ---------- состояние ----------
  var S = { a: {}, n: [], open: true };
  var mem = null;
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { raw = mem; }
    if (!raw) return;
    try {
      var d = JSON.parse(raw);
      if (d && typeof d.a === "object" && Array.isArray(d.n)) { S.a = d.a; S.n = d.n; S.open = d.open !== false; }
    } catch (e) { /* битые данные игнорируем */ }
  }
  function save() {
    var raw = JSON.stringify({ kit: 1, mockup: FILE, open: S.open, a: S.a, n: S.n });
    try { localStorage.setItem(KEY, raw); } catch (e) { mem = raw; }
  }
  function ans(id) { return S.a[id] || (S.a[id] = { v: [], own: "", c: "" }); }
  function answered(id) { var a = S.a[id]; return !!a && (a.v.length > 0 || oneLine(a.own) !== ""); }

  // ---------- разбор разметки ----------
  var Q = [], QM = {};
  function collect() {
    $$("[data-q]").forEach(function (el) {
      var id = el.getAttribute("data-q");
      var q = QM[id];
      if (!q) { q = QM[id] = { id: id, title: "", rec: "", vars: [], els: [], vels: [], rows: [], closed: false, btns: [], inputs: [], stats: [] }; Q.push(q); }
      if (el.hasAttribute("data-q-title") && !q.title) q.title = el.getAttribute("data-q-title");
      if (el.hasAttribute("data-recommended") && !q.rec) q.rec = el.getAttribute("data-recommended");
      if (el.hasAttribute("data-q-closed")) q.closed = true;
      (el.getAttribute("data-variants") || "").split(",").forEach(function (v) { v = v.trim(); if (v && q.vars.indexOf(v) < 0) q.vars.push(v); });
      var v = el.getAttribute("data-variant");
      if (v) { if (q.vars.indexOf(v) < 0) q.vars.push(v); q.vels.push({ v: v, el: el }); }
      else if (el.tagName === "TR") q.rows.push(el);
      else q.els.push(el);
    });
    Q.sort(function (a, b) { return a.id.localeCompare(b.id, "ru", { numeric: true }); });
  }
  function recList(q) {
    return q.rec.split(/[+,\s]+/).filter(function (v) { return q.vars.indexOf(v) >= 0; });
  }
  function target(q, v) {
    if (v) for (var i = 0; i < q.vels.length; i++) if (q.vels[i].v === v) return q.vels[i].el;
    return q.els[0] || (q.vels[0] && q.vels[0].el) || q.rows[0] || null;
  }

  // ---------- действия над ответами ----------
  function pick(q, v, multi) {
    var a = ans(q.id), i = a.v.indexOf(v);
    if (multi) { if (i >= 0) a.v.splice(i, 1); else a.v.push(v); }
    else a.v = i >= 0 && a.v.length === 1 ? [] : [v];
    a.v.sort(function (x, y) { return q.vars.indexOf(x) - q.vars.indexOf(y); });
    changed();
  }
  function clearAnswer(q) { S.a[q.id] = { v: [], own: "", c: (S.a[q.id] || {}).c || "" }; ownOpen[q.id] = false; changed(); }
  var ownOpen = {};

  function statText(q) {
    var a = S.a[q.id], p = [];
    if (a && a.v.length) p.push(a.v.join("+"));
    if (a && oneLine(a.own)) p.push("свой");
    return p.length ? p.join(" + ") : "—";
  }

  function summary() {
    var out = ["Макет: " + FILE], miss = [];
    Q.forEach(function (q) {
      if (q.closed) return;
      var a = S.a[q.id], c = a ? oneLine(a.c) : "", parts = [];
      if (!answered(q.id)) {
        miss.push(q.id);
        if (c) out.push(q.id + " (без выбора) — " + c);
        return;
      }
      if (a.v.length) parts.push(a.v.join("+"));
      if (oneLine(a.own)) parts.push("свой: " + oneLine(a.own));
      out.push(q.id + " " + parts.join(", ") + (c ? " — " + c : ""));
    });
    if (miss.length) out.push("Без ответа: " + miss.join(", "));
    var notes = S.n.filter(function (n) { return oneLine(n.text); });
    if (notes.length) {
      out.push("Заметки:");
      notes.forEach(function (n) { out.push("- [" + noteCtx(n) + "] " + oneLine(n.text)); });
    }
    return out.join("\n");
  }
  function noteCtx(n) {
    var tail = [n.ref, n.quote ? "«" + n.quote + "»" : ""].filter(Boolean).join(" ");
    return [n.screen, tail].filter(Boolean).join(", ");
  }

  // ---------- интерфейс на самом макете ----------
  function mkBar(q, v) {
    var bar = h("span", { class: "mk-bar" });
    if (v) {
      var b = h("button", { type: "button", "aria-pressed": "false", title: "Выбрать вариант; Shift+щелчок — несколько вариантов" }, "Выбрать " + q.id + " " + v);
      b.addEventListener("click", function (e) { pick(q, v, e.shiftKey || e.ctrlKey); });
      q.btns.push({ el: b, v: v });
      bar.appendChild(b);
    } else {
      var st = h("span", { class: "mk-stat" });
      q.stats.push(st);
      bar.appendChild(st);
    }
    var inp = h("input", { type: "text", placeholder: "Комментарий к " + q.id + "…", "aria-label": "Комментарий к вопросу " + q.id });
    inp.addEventListener("input", function () { ans(q.id).c = inp.value; changed(inp); });
    q.inputs.push(inp);
    bar.appendChild(inp);
    return bar;
  }
  function injectBars() {
    Q.forEach(function (q) {
      q.vels.forEach(function (x) {
        var bar = mkBar(q, x.v);
        x.el.insertBefore(bar, x.el.firstChild);
      });
      q.els.forEach(function (el) {
        var bar = mkBar(q, null);
        el.insertBefore(bar, el.firstChild);
      });
    });
  }

  // ---------- панель ----------
  var panel, tab, listEl, notesEl, countEl, sumEl, rec, lastItem = null;
  function chip(label, extra) { return h("button", Object.assign({ type: "button", "aria-pressed": "false" }, extra || {}), label); }
  function buildItem(q) {
    var it = h("div", { class: "mk-item", tabindex: "-1", "data-id": q.id });
    var line = h("div", { class: "mk-line" });
    var num = h("a", { class: "mk-num", title: "Перейти к вопросу" }, q.id);
    num.addEventListener("click", function () { go(target(q)); });
    var ttl = h("span", { class: "mk-ttl" }, (q.closed ? "снят · " : "") + (q.title || ""));
    var st = h("span", { class: "mk-stat" });
    q.itemStat = st;
    line.appendChild(num); line.appendChild(ttl); line.appendChild(st);
    it.appendChild(line);
    var vs = h("div", { class: "mk-vs" });
    q.pbtns = [];
    q.vars.forEach(function (v) {
      var isRec = recList(q).indexOf(v) >= 0;
      var b = chip(v + (isRec ? " ★" : ""), { title: (isRec ? "Рекомендую. " : "") + "Shift+щелчок — несколько вариантов; Alt+щелчок — перейти к варианту" });
      b.addEventListener("click", function (e) {
        if (e.altKey) { go(target(q, v)); return; }
        pick(q, v, e.shiftKey || e.ctrlKey);
      });
      q.pbtns.push({ el: b, v: v });
      vs.appendChild(b);
    });
    q.ownBtn = chip("свой", { title: "Ответить своим вариантом текстом" });
    q.ownBtn.addEventListener("click", function () {
      ownOpen[q.id] = !ownOpen[q.id] && !oneLine(ans(q.id).own);
      if (!ownOpen[q.id]) ans(q.id).own = "";
      changed();
      if (ownOpen[q.id]) q.ownIn.focus();
    });
    vs.appendChild(q.ownBtn);
    it.appendChild(vs);
    q.ownIn = h("input", { type: "text", placeholder: "Свой вариант…", "aria-label": "Свой вариант " + q.id });
    q.ownIn.addEventListener("input", function () { ans(q.id).own = q.ownIn.value; changed(q.ownIn); });
    it.appendChild(q.ownIn);
    q.ta = h("textarea", { rows: "1", placeholder: "Комментарий (Enter — сюда, Esc — назад)", "aria-label": "Комментарий " + q.id });
    q.ta.addEventListener("input", function () { ans(q.id).c = q.ta.value; changed(q.ta); });
    it.appendChild(q.ta);
    q.item = it;
    it.addEventListener("focus", function () { lastItem = it; });
    return it;
  }
  function buildPanel() {
    panel = h("aside", { class: "mk-panel", "aria-label": "Ответы" });
    var head = h("div", { class: "mk-head" });
    head.appendChild(h("b", {}, "Ответы"));
    head.appendChild(h("span", { class: "mk-file" }, FILE));
    var close = h("button", { type: "button", title: "Свернуть (клавиша `)" }, "Свернуть");
    close.addEventListener("click", function () { setOpen(false); });
    head.appendChild(close);
    panel.appendChild(head);
    var hint = h("div", { class: "mk-hint" });
    hint.innerHTML = "<kbd>`</kbd> панель · <kbd>↑</kbd><kbd>↓</kbd> вопросы · <kbd>А</kbd><kbd>Б</kbd><kbd>В</kbd> или <kbd>1</kbd><kbd>2</kbd> вариант (с Shift — несколько) · <kbd>Enter</kbd> комментарий · <kbd>Del</kbd> очистить · <kbd>Alt</kbd>+щелчок по макету — заметка";
    panel.appendChild(hint);
    var sc = h("div", { class: "mk-scroll" });
    listEl = h("div", { class: "mk-list" });
    Q.forEach(function (q) { listEl.appendChild(buildItem(q)); });
    sc.appendChild(listEl);
    sc.appendChild(h("div", { class: "mk-sec" }, "Заметки"));
    notesEl = h("div", { class: "mk-notes" });
    sc.appendChild(notesEl);
    panel.appendChild(sc);
    var foot = h("div", { class: "mk-foot" });
    countEl = h("div", { class: "mk-count" });
    foot.appendChild(countEl);
    rec = h("button", { type: "button" }, "Взять рекомендации для неотвеченных");
    rec.addEventListener("click", takeRecs);
    foot.appendChild(rec);
    sumEl = h("textarea", { class: "mk-sum", readonly: "", "aria-label": "Сводка" });
    foot.appendChild(sumEl);
    var row = h("div", { class: "mk-row" });
    var copy = h("button", { type: "button", "aria-pressed": "false" }, "Скопировать");
    copy.addEventListener("click", function () { copyText(sumEl.value, copy); });
    var exp = h("button", { type: "button" }, "Экспорт JSON");
    exp.addEventListener("click", exportJson);
    var imp = h("button", { type: "button" }, "Импорт JSON");
    var file = h("input", { type: "file", accept: "application/json,.json", hidden: "" });
    imp.addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function () { importJson(file); });
    var rst = h("button", { type: "button" }, "Сбросить");
    rst.addEventListener("click", resetAll);
    [copy, exp, imp, rst, file].forEach(function (b) { row.appendChild(b); });
    foot.appendChild(row);
    panel.appendChild(foot);
    doc.body.appendChild(panel);

    tab = h("button", { type: "button", class: "mk-tab", title: "Открыть панель (клавиша `)" });
    tab.addEventListener("click", function () { setOpen(true); });
    doc.body.appendChild(tab);
    panel.addEventListener("keydown", panelKeys);
  }
  function setOpen(v, focus) {
    S.open = v;
    panel.hidden = !v;
    tab.hidden = v;
    doc.documentElement.classList.toggle("mk-open", v);
    save();
    layout();
    if (v && focus !== false) {
      var it = lastItem || (Q[0] && Q[0].item);
      if (it) it.focus({ preventScroll: false });
    } else if (!v && panel.contains(doc.activeElement)) doc.activeElement.blur();
  }
  function go(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("mk-flash"); void el.offsetWidth; el.classList.add("mk-flash");
    setTimeout(function () { el.classList.remove("mk-flash"); }, 1500);
  }
  function takeRecs() {
    var n = 0;
    Q.forEach(function (q) {
      if (q.closed || answered(q.id)) return;
      var r = recList(q);
      if (r.length) { ans(q.id).v = r; n++; }
    });
    changed();
    toast(n ? "Рекомендации взяты: " + n : "Нечего брать: все отвечены или рекомендаций нет");
  }

  // ---------- клавиши ----------
  function variantFor(q, e) {
    var k = e.key, i;
    for (i = 0; i < q.vars.length; i++) if (q.vars[i].toLowerCase() === k.toLowerCase()) return q.vars[i];
    if (/^[A-Za-z]$/.test(k) && RU_BY_CODE[e.code] && q.vars.indexOf(RU_BY_CODE[e.code]) >= 0) return RU_BY_CODE[e.code];
    if (/^[1-9]$/.test(k) && q.vars[+k - 1]) return q.vars[+k - 1];
    return null;
  }
  function panelKeys(e) {
    var t = e.target;
    if (typing(t)) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); var it0 = t.closest(".mk-item"); if (it0) it0.focus(); }
      return;
    }
    var it = t.closest && t.closest(".mk-item");
    if (!it) return;
    var q = QM[it.getAttribute("data-id")], idx = Q.indexOf(q);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      var n = Q[Math.max(0, Math.min(Q.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)))];
      n.item.focus();
    } else if (e.key === "Enter") {
      e.preventDefault(); q.ta.focus();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault(); clearAnswer(q);
    } else if (e.key === "Escape") {
      e.preventDefault(); setOpen(false);
    } else if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      var v = variantFor(q, e);
      if (v) { e.preventDefault(); pick(q, v, e.shiftKey); }
    }
  }
  doc.addEventListener("keydown", function (e) {
    if (!panel || e.code !== TOGGLE_CODE || e.ctrlKey || e.altKey || e.metaKey) return;
    if (typing(e.target) || inLive(e.target)) return;
    e.preventDefault();
    setOpen(!S.open);
  });

  // ---------- заметки Alt+щелчок ----------
  var layer, pop = null;
  function pathOf(el) {
    var parts = [];
    while (el && el !== doc.body) {
      var sibs = Array.prototype.filter.call(el.parentNode.children, function (c) { return !c.hasAttribute("data-mk"); });
      parts.unshift(sibs.indexOf(el));
      el = el.parentNode;
    }
    return parts.join("/");
  }
  function resolve(path) {
    var el = doc.body, ix = path === "" ? [] : path.split("/");
    for (var i = 0; i < ix.length; i++) {
      var sibs = Array.prototype.filter.call(el.children, function (c) { return !c.hasAttribute("data-mk"); });
      el = sibs[+ix[i]];
      if (!el) return null;
    }
    return el;
  }
  function before(a, b) { return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }
  function lastBefore(list, el) {
    var r = null;
    for (var i = 0; i < list.length; i++) { if (list[i] === el || before(list[i], el)) r = list[i]; else break; }
    return r;
  }
  function describe(el) {
    var h2s = $$("h2").filter(function (x) { return !x.closest("[data-mk]") && !x.closest(".qs"); });
    var h2 = lastBefore(h2s, el), screen = "";
    if (h2) {
      var tx = oneLine(h2.textContent), m = /^Экран\s+(\d+)/i.exec(tx);
      screen = m ? "экран " + m[1] : tx.slice(0, 40);
    }
    var ref = "", own = el.closest("[data-variant],[data-q]:not(tr)");
    if (!own) {
      var all = $$("[data-q]:not(tr)").filter(function (x) { return !x.closest("[data-mk]"); });
      own = lastBefore(all, el);
      if (own && h2 && !before(h2, own) && own !== h2) own = null; // вопрос из предыдущего экрана не подходит
    }
    if (own) ref = own.getAttribute("data-q") + (own.getAttribute("data-variant") ? " " + own.getAttribute("data-variant") : "");
    var clone = el.cloneNode(true);
    $$("[data-mk]", clone).forEach(function (x) { x.remove(); });
    var quote = oneLine(clone.textContent);
    if (quote.length > 40) quote = quote.slice(0, 40).trim() + "…";
    return { screen: screen, ref: ref, quote: quote };
  }
  function closePop(keep) {
    if (!pop) return;
    var t = pop.targetEl;
    if (t) t.classList.remove("mk-target");
    pop.remove(); pop = null;
    if (!keep) layout();
  }
  function openPop(note, isNew, el) {
    closePop(true);
    pop = h("div", { class: "mk-pop", role: "dialog", "aria-label": "Заметка" });
    pop.targetEl = el;
    if (el) el.classList.add("mk-target");
    pop.appendChild(h("small", {}, noteCtx(note) || "заметка"));
    var ta = h("textarea", { "aria-label": "Текст заметки", placeholder: "Что здесь не так или что поправить" });
    ta.value = note.text || "";
    pop.appendChild(ta);
    var row = h("div", { class: "mk-row" });
    var del = h("button", { type: "button" }, "Удалить");
    var cancel = h("button", { type: "button" }, "Закрыть");
    var ok = h("button", { type: "button", class: "mk-main" }, "Сохранить");
    function commit() {
      var text = ta.value.trim();
      var i = S.n.indexOf(note);
      if (text) { note.text = text; if (i < 0) S.n.push(note); }
      else if (i >= 0) S.n.splice(i, 1);
      closePop(true); notesChanged();
    }
    ok.addEventListener("click", commit);
    cancel.addEventListener("click", function () { closePop(); });
    del.addEventListener("click", function () {
      var i = S.n.indexOf(note); if (i >= 0) S.n.splice(i, 1);
      closePop(true); notesChanged();
    });
    ta.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); closePop(); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    });
    [del, cancel, ok].forEach(function (b) { row.appendChild(b); });
    pop.appendChild(row);
    doc.body.appendChild(pop);
    var r = el ? el.getBoundingClientRect() : { left: 100, bottom: 100, top: 100 };
    var x = Math.max(8, Math.min(r.left, innerWidth - (S.open ? 372 : 0) - 320));
    var y = r.bottom + 8 > innerHeight - 190 ? Math.max(8, r.top - 190) : r.bottom + 8;
    pop.style.left = x + "px"; pop.style.top = y + "px";
    ta.focus();
  }
  doc.addEventListener("click", function (e) {
    if (!e.altKey || !e.target.closest || e.target.closest("[data-mk]")) return;
    e.preventDefault(); e.stopPropagation();
    var el = e.target, d = describe(el);
    openPop({ path: pathOf(el), tag: el.tagName, screen: d.screen, ref: d.ref, quote: d.quote, text: "" }, true, el);
  }, true);

  function notesChanged() { save(); renderNotes(); layout(); refresh(); }
  function renderNotes() {
    notesEl.textContent = "";
    var pins = $$(".mk-pin");
    pins.forEach(function (p) { p.remove(); });
    if (!S.n.length) { notesEl.appendChild(h("div", { class: "mk-note" }, "Нет. Alt+щелчок по любому месту макета.")); }
    S.n.forEach(function (n, i) {
      var row = h("div", { class: "mk-note" });
      var num = h("a", { title: "Показать на макете" }, String(i + 1));
      num.addEventListener("click", function () { var t = resolve(n.path); if (t) go(t); else openPop(n, false, null); });
      var sp = h("span", {}, oneLine(n.text));
      var sm = h("small", {}, " " + noteCtx(n));
      sp.appendChild(sm);
      var edit = h("button", { type: "button", title: "Изменить" }, "✎");
      edit.addEventListener("click", function () { openPop(n, false, resolve(n.path)); });
      row.appendChild(num); row.appendChild(sp); row.appendChild(edit);
      notesEl.appendChild(row);
      var pin = h("button", { type: "button", class: "mk-pin", title: oneLine(n.text), "aria-label": "Заметка " + (i + 1) }, String(i + 1));
      pin.addEventListener("click", function () { openPop(n, false, resolve(n.path)); });
      pin.noteRef = n;
      layer.appendChild(pin);
    });
    layout();
  }
  function layout() {
    if (!layer) return;
    $$(".mk-pin", layer).forEach(function (pin) {
      var el = resolve(pin.noteRef.path);
      if (!el) { pin.style.display = "none"; return; }
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) { pin.style.display = "none"; return; }
      pin.style.display = "";
      pin.style.left = Math.max(2, r.left + scrollX - 8) + "px";
      pin.style.top = (r.top + scrollY - 8) + "px";
    });
  }

  // ---------- обновление ----------
  function changed(skip) { save(); refresh(skip); }
  function setVal(inp, val, skip) { if (inp !== skip && inp !== doc.activeElement && inp.value !== val) inp.value = val; }
  function refresh(skip) {
    var done = 0, total = 0;
    Q.forEach(function (q) {
      var a = S.a[q.id] || { v: [], own: "", c: "" };
      q.btns.forEach(function (b) { b.el.setAttribute("aria-pressed", a.v.indexOf(b.v) >= 0 ? "true" : "false"); });
      q.pbtns.forEach(function (b) { b.el.setAttribute("aria-pressed", a.v.indexOf(b.v) >= 0 ? "true" : "false"); });
      q.vels.forEach(function (x) { x.el.classList.toggle("mk-sel", a.v.indexOf(x.v) >= 0); });
      var st = statText(q);
      q.stats.forEach(function (s) { s.textContent = st === "—" ? "" : "ответ: " + st; });
      q.itemStat.textContent = st;
      var ok = answered(q.id);
      q.item.classList.toggle("mk-done", ok);
      q.item.classList.toggle("mk-closed", q.closed);
      q.ownBtn.setAttribute("aria-pressed", oneLine(a.own) ? "true" : "false");
      q.ownIn.style.display = ownOpen[q.id] || oneLine(a.own) ? "" : "none";
      setVal(q.ownIn, a.own, skip);
      setVal(q.ta, a.c, skip);
      q.inputs.forEach(function (i) { setVal(i, a.c, skip); });
      if (!q.closed) { total++; if (ok) done++; }
    });
    countEl.textContent = "отвечено " + done + " из " + total;
    tab.textContent = "Ответы " + done + "/" + total + "  ` ";
    sumEl.value = summary();
  }

  // ---------- копирование, экспорт, импорт, сброс ----------
  var toastEl = null;
  function toast(msg) {
    if (toastEl) toastEl.remove();
    toastEl = h("div", { class: "mk-toast", role: "status" }, msg);
    doc.body.appendChild(toastEl);
    var t = toastEl;
    setTimeout(function () { if (t.parentNode) t.remove(); }, 2200);
  }
  function copyText(text, btn) {
    function fallback() {
      sumEl.focus(); sumEl.select();
      var ok = false;
      try { ok = doc.execCommand("copy"); } catch (e) { ok = false; }
      toast(ok ? "Сводка скопирована" : "Не удалось скопировать — выделено, нажмите Ctrl+C");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Сводка скопирована"); }, fallback);
    } else fallback();
  }
  function exportJson() {
    var blob = new Blob([JSON.stringify({ kit: 1, mockup: FILE, a: S.a, n: S.n }, null, 2)], { type: "application/json" });
    var a = doc.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = FILE.replace(/\.html?$/, "") + "-answers.json";
    a.setAttribute("data-mk", "");
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function importJson(input) {
    var f = input.files && input.files[0];
    input.value = "";
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var d = JSON.parse(String(r.result));
        if (!d || typeof d.a !== "object" || !Array.isArray(d.n)) throw new Error("формат");
        if ((Object.keys(S.a).length || S.n.length) && !confirm("Заменить текущие ответы и заметки импортированными?")) return;
        S.a = d.a; S.n = d.n;
        save(); renderNotes(); refresh(); toast("Импортировано");
      } catch (e) { toast("Не удалось прочитать файл ответов"); }
    };
    r.readAsText(f);
  }
  function resetAll() {
    if (!confirm("Сбросить все ответы и заметки в этом макете?")) return;
    S.a = {}; S.n = []; ownOpen = {};
    save(); renderNotes(); refresh();
  }

  // ---------- запуск ----------
  function init() {
    load();
    collect();
    if (!Q.length) return;
    layer = h("div", { class: "mk-layer" });
    layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible";
    doc.body.appendChild(layer);
    injectBars();
    buildPanel();
    renderNotes();
    refresh();
    setOpen(S.open, false);
    addEventListener("resize", layout);
    addEventListener("load", layout);
    doc.addEventListener("click", function () { setTimeout(layout, 200); });
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init); else init();
})();
