// muteki-workbench 浏览器半：右侧栏「Muteki 工作台」页签。
// 档位按钮（默认推荐值）+ 模式卡片 + 开关 + 差异化保存按钮 + 悬浮提示 + 实时账本。
// 覆盖写 storageDir/settings.json → POST /api/muteki/settings（orchestrator 运行时生效，不用重启）。
// 契约对照 @adwmc/helm-d client.js：sidebarRightTabs.register + sidebar.right.pane.tab slot。
window.__ModuleLoader__.load({
  id: "muteki-workbench",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    exports.inject = ["slots", "sidebarRight", "sidebarRightTabs", "sessions"];

    // ── 设计系统：战术控制台配色（深墨蓝底 + 电青/酸绿/琥珀/品红）──────────────
    var CSS = [
      ".mw-root{--bg:#070b16;--surface:#0d1424;--overlay:#141d33;--line:#22304d;",
      "--cyan:#22d3ee;--green:#34d399;--acid:#a3e635;--amber:#fbbf24;--magenta:#e879f9;",
      "--red:#f87171;--violet:#8b5cf6;--text:#e6edf7;--dim:#8fa3c0;--faint:#5b6c8c;",
      "position:relative;height:100%;display:flex;flex-direction:column;overflow:hidden;color:var(--text);",
      "font:13px/1.55 'Segoe UI',system-ui,-apple-system,sans-serif;padding:0;",
      "background:radial-gradient(1100px 420px at 18% -12%,rgba(34,211,238,.10),transparent 60%),",
      "radial-gradient(900px 380px at 92% -6%,rgba(232,121,249,.09),transparent 62%),",
      "linear-gradient(180deg,#0a1020 0%,var(--bg) 40%);}",
      ".mw-root::before{content:'';position:absolute;inset:0;pointer-events:none;",
      "background:linear-gradient(rgba(34,211,238,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(34,211,238,.035) 1px,transparent 1px);",
      "background-size:28px 28px;mask-image:linear-gradient(180deg,#000 0%,transparent 70%);}",
      ".mw-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:16px 16px 12px;position:relative}",
      ".mw-scroll::-webkit-scrollbar{width:10px}",
      ".mw-scroll::-webkit-scrollbar-track{background:var(--bg)}",
      ".mw-scroll::-webkit-scrollbar-thumb{background:linear-gradient(180deg,var(--cyan),var(--violet));border-radius:8px;border:2px solid var(--bg)}",
      ".mw-scroll::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,var(--acid),var(--magenta))}",
      ".mw-root>*{position:relative}",
      ".mw-eyebrow{font:600 10px/1 ui-monospace,'Cascadia Code',Consolas,monospace;letter-spacing:.22em;color:var(--cyan);text-transform:uppercase;display:flex;align-items:center;gap:8px}",
      ".mw-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(52,211,153,.6);animation:mwPulse 2s infinite}",
      "@keyframes mwPulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}70%{box-shadow:0 0 0 8px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}",
      ".mw-title{font-size:22px;font-weight:800;letter-spacing:.01em;margin:6px 0 2px;background:linear-gradient(90deg,#fff,var(--cyan) 60%,var(--magenta));-webkit-background-clip:text;background-clip:text;color:transparent}",
      ".mw-sub{color:var(--dim);font-size:12px;margin-bottom:16px}",
      ".mw-sec{margin:0 0 18px;animation:mwUp .5s cubic-bezier(.2,.7,.3,1) both}",
      ".mw-sec-h{display:flex;align-items:baseline;gap:8px;font-size:12px;font-weight:700;color:var(--text);margin-bottom:8px}",
      ".mw-sec-h .idx{font:700 10px/1 ui-monospace,monospace;color:var(--faint);letter-spacing:.1em}",
      ".mw-sec-h .hint{margin-left:auto;font-weight:400;color:var(--faint);font-size:11px}",
      ".mw-modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px}",
      ".mw-mode{--ac:var(--cyan);text-align:left;cursor:pointer;border:1px solid var(--line);border-radius:12px;",
      "background:linear-gradient(160deg,var(--overlay),var(--surface));padding:10px 10px 9px;color:var(--text);",
      "transition:transform .16s,border-color .16s,box-shadow .16s;position:relative;overflow:hidden}",
      ".mw-mode:hover{transform:translateY(-2px);border-color:var(--ac);box-shadow:0 6px 18px -8px var(--ac)}",
      ".mw-mode.on{border-color:var(--ac);background:var(--ac);background:linear-gradient(160deg,var(--ac),color-mix(in srgb,var(--ac) 68%,#000));color:#041018;box-shadow:0 0 0 1px var(--ac),0 10px 26px -10px var(--ac)}",
      ".mw-mode.on .ic,.mw-mode.on .nm{color:#041018}",
      ".mw-mode.on .ds{color:rgba(4,16,24,.78)}",
      ".mw-mode.on::after{content:'';position:absolute;top:8px;right:8px;width:6px;height:6px;border-radius:50%;background:#041018;box-shadow:none}",
      ".mw-mode .ic{font-size:15px;line-height:1;color:var(--ac)}",
      ".mw-mode .nm{font-weight:700;font-size:12.5px;margin:5px 0 2px}",
      ".mw-mode .ds{font-size:10.5px;color:var(--dim);line-height:1.4}",
      ".mw-follow{margin-top:8px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;border:1px dashed var(--line);",
      "border-radius:999px;background:transparent;color:var(--dim);font-size:11px;padding:4px 12px;transition:.16s;white-space:nowrap;flex:none}",
      ".mw-follow:hover{color:var(--cyan);border-color:var(--cyan)}",
      ".mw-follow.on{color:#041018;border-color:var(--cyan);border-style:solid;background:var(--cyan);font-weight:700}",
      ".mw-tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px}",
      ".mw-tier{--ac:var(--green);cursor:pointer;border:1px solid var(--line);border-radius:12px;padding:10px;",
      "background:linear-gradient(160deg,var(--overlay),var(--surface));color:var(--text);text-align:left;transition:transform .16s,border-color .16s,box-shadow .16s;position:relative}",
      ".mw-tier:hover{transform:translateY(-2px);border-color:var(--ac);box-shadow:0 6px 18px -8px var(--ac)}",
      ".mw-tier.on{border-color:var(--ac);background:var(--ac);background:linear-gradient(160deg,var(--ac),color-mix(in srgb,var(--ac) 68%,#000));color:#041018;box-shadow:0 0 0 1px var(--ac),0 10px 26px -10px var(--ac)}",
      ".mw-tier.on .nm{color:#041018}",
      ".mw-tier.on .badge{background:#041018;color:var(--ac)}",
      ".mw-tier.on .ds{color:rgba(4,16,24,.78)}",
      ".mw-tier .nm{font-weight:800;font-size:13px;color:var(--ac);display:flex;align-items:center;gap:6px}",
      ".mw-tier .badge{font:700 9px/1 ui-monospace,monospace;letter-spacing:.08em;color:#041018;background:var(--ac);border-radius:4px;padding:2px 5px}",
      ".mw-tier .ds{font-size:10.5px;color:var(--dim);margin:3px 0 6px}",
      ".mw-tier .nums{font:11px/1.5 ui-monospace,'Cascadia Code',Consolas,monospace;color:var(--faint)}",
      ".mw-tier.on .nums{color:rgba(4,16,24,.8)}",
      ".mw-readout{margin-top:8px;border:1px solid var(--line);border-left:3px solid var(--cyan);border-radius:8px;",
      "background:rgba(13,20,36,.7);padding:8px 10px;font:11.5px/1.6 ui-monospace,'Cascadia Code',Consolas,monospace;color:var(--dim)}",
      ".mw-readout b{color:var(--cyan);font-weight:600}",
      ".mw-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:10px 12px}",
      ".mw-row .lb{font-size:12.5px;font-weight:600}",
      ".mw-row .ds{font-size:11px;color:var(--dim)}",
      ".mw-switch{margin-left:auto;--ac:var(--green);width:42px;height:23px;border-radius:999px;border:1px solid var(--line);",
      "background:var(--overlay);cursor:pointer;position:relative;transition:.2s;flex:none}",
      ".mw-switch::after{content:'';position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:var(--faint);transition:.2s cubic-bezier(.2,.7,.3,1.4)}",
      ".mw-switch.on{background:color-mix(in srgb,var(--ac) 30%,var(--overlay));border-color:var(--ac)}",
      ".mw-switch.on::after{left:21px;background:var(--ac);box-shadow:0 0 10px var(--ac)}",
      ".mw-adv{border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:hidden}",
      ".mw-adv summary{cursor:pointer;padding:9px 12px;font-size:12px;font-weight:600;color:var(--dim);list-style:none;display:flex;align-items:center;gap:8px}",
      ".mw-adv summary::-webkit-details-marker{display:none}",
      ".mw-adv summary::before{content:'▸';color:var(--cyan);transition:.2s}",
      ".mw-adv[open] summary::before{transform:rotate(90deg)}",
      ".mw-adv summary:hover{color:var(--text)}",
      ".mw-adv .body{padding:4px 12px 12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}",
      ".mw-num{display:block}",
      ".mw-num .lb{font-size:10.5px;color:var(--dim);display:block;margin-bottom:3px}",
      ".mw-num input{width:100%;box-sizing:border-box;background:var(--overlay);border:1px solid var(--line);border-radius:8px;color:var(--text);",
      "font:12px ui-monospace,monospace;padding:6px 8px;transition:.16s}",
      ".mw-num input:focus{outline:none;border-color:var(--cyan);box-shadow:0 0 0 2px rgba(34,211,238,.2)}",
      ".mw-num select{width:100%;box-sizing:border-box;background:var(--overlay);border:1px solid var(--line);border-radius:8px;color:var(--text);font:12px ui-monospace,monospace;padding:6px 8px}",
      ".mw-num select:focus{outline:none;border-color:var(--cyan)}",
      ".mw-span{grid-column:1 / -1;font-size:10.5px;color:var(--faint);line-height:1.5}",
      ".mw-savebar{flex:none;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;",
      "border-top:1px solid var(--line);background:linear-gradient(180deg,rgba(13,20,36,.96),rgba(7,11,22,.99));backdrop-filter:blur(6px)}",
      ".mw-save{--g:linear-gradient(135deg,var(--cyan),var(--violet) 52%,var(--magenta));flex:1;cursor:pointer;border:none;border-radius:999px;",
      "padding:12px 18px;color:#041018;font-weight:800;font-size:13.5px;letter-spacing:.02em;position:relative;overflow:hidden;",
      "background:var(--g);box-shadow:0 8px 26px -10px var(--cyan),0 4px 14px -6px var(--magenta);transition:transform .16s,box-shadow .16s,filter .16s}",
      ".mw-save::before{content:'';position:absolute;top:0;left:-60%;width:40%;height:100%;transform:skewX(-20deg);",
      "background:linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent);transition:left .5s}",
      ".mw-save:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 12px 32px -10px var(--cyan),0 6px 20px -6px var(--magenta)}",
      ".mw-save:hover:not(:disabled)::before{left:120%}",
      ".mw-save:active:not(:disabled){transform:translateY(0)}",
      ".mw-save:disabled{filter:grayscale(.7) brightness(.6);cursor:not-allowed;box-shadow:none}",
      ".mw-save.done{background:linear-gradient(135deg,var(--green),var(--acid));box-shadow:0 8px 26px -10px var(--green)}",
      ".mw-dirty{font:11px ui-monospace,monospace;color:var(--amber);white-space:nowrap}",
      ".mw-dirty.clean{color:var(--faint)}",
      ".mw-stats{display:grid;gap:8px}",
      ".mw-stat{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:9px 12px;transition:border-color .16s}",
      ".mw-stat:hover{border-color:var(--violet)}",
      ".mw-stat .ch{font:700 12px ui-monospace,monospace;color:var(--text);display:flex;align-items:center;gap:8px}",
      ".mw-stat .ch .tag{font:700 9px/1 ui-monospace,monospace;color:var(--magenta);border:1px solid color-mix(in srgb,var(--magenta) 50%,transparent);border-radius:4px;padding:2px 5px}",
      ".mw-stat .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px}",
      ".mw-stat .cell .k{font-size:10px;color:var(--faint)}",
      ".mw-stat .cell .v{font:700 13px ui-monospace,monospace;color:var(--cyan)}",
      ".mw-stat .cell .v.cost{color:var(--amber)}",
      ".mw-stat .cell .v.tok{color:var(--green)}",
      ".mw-bar{height:3px;border-radius:2px;background:var(--overlay);margin-top:7px;overflow:hidden}",
      ".mw-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--green),var(--cyan));border-radius:2px;transition:width .4s}",
      ".mw-empty{color:var(--faint);font-size:12px;border:1px dashed var(--line);border-radius:12px;padding:14px;text-align:center}",
      ".mw-note{margin-top:8px;font-size:11px;color:var(--amber);display:flex;gap:6px;align-items:flex-start;line-height:1.5}",
      ".mw-note::before{content:'⚠';flex:none}",
      ".mw-flags{margin:0 0 12px;border:1px solid var(--green);border-radius:12px;padding:10px 12px;background:linear-gradient(160deg,rgba(52,211,153,.14),rgba(52,211,153,.04));box-shadow:0 0 0 1px rgba(52,211,153,.25),0 8px 24px -12px var(--green)}",
      ".mw-flags-h{font:800 11px/1 ui-monospace,monospace;letter-spacing:.08em;color:var(--green);margin-bottom:8px}",
      ".mw-flag{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;padding:5px 0;border-top:1px dashed rgba(52,211,153,.3)}",
      ".mw-flag:first-of-type{border-top:0}",
      ".mw-flag .v{font:700 12.5px/1.4 ui-monospace,'Cascadia Code',Consolas,monospace;color:#eafff5;word-break:break-all}",
      ".mw-flag .meta{font-size:10.5px;color:var(--dim)}",
      ".mw-tip{position:fixed;z-index:9999;transform:translate(-50%,-100%);pointer-events:none;",
      "background:linear-gradient(160deg,#1a2440,#101828);border:1px solid #22d3ee;border-radius:9px;",
      "color:#ffffff;font-size:11.5px;line-height:1.5;padding:7px 10px;max-width:240px;",
      "box-shadow:0 10px 30px -10px rgba(34,211,238,.5);animation:mwTip .16s cubic-bezier(.2,.7,.3,1) both}",
      ".mw-tip::after{content:'';position:absolute;left:50%;bottom:-5px;width:8px;height:8px;transform:translateX(-50%) rotate(45deg);",
      "background:#101828;border-right:1px solid #22d3ee;border-bottom:1px solid #22d3ee}",
      "@keyframes mwTip{from{opacity:0;transform:translate(-50%,calc(-100% + 5px))}to{opacity:1;transform:translate(-50%,-100%)}}",
      "@keyframes mwUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}",
      ".mw-root button:focus-visible,.mw-root summary:focus-visible,.mw-root input:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}",
    ].join("");

    function ensureStyle() {
      if (document.getElementById("mw-style")) return;
      var el = document.createElement("style");
      el.id = "mw-style";
      el.setAttribute("data-plugin", "muteki-workbench");
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    // ── 档位（推荐值 bundles）──────────────────────────────────────────────
    var NUMKEYS = ["poolSize", "maxRunsPerHour", "burstRuns", "maxCostUsdPerHour", "maxCostUsdPerChallenge", "stagnationLimit"];
    // 档位推荐值按 DeepSeek 实际口径（costBasis=actual）标定：DeepSeek 远比 Anthropic 标价便宜，
    // 墙值用 usdActual 尺度（≈估算×0.1），换算人民币后才是真实量级。
    var BUNDLES = [
      { id: "safe", name: "稳妥", ac: "var(--cyan)", desc: "低并发 · 省钱慢打", v: { poolSize: 4, maxRunsPerHour: 60, burstRuns: 60, maxCostUsdPerHour: 2.5, maxCostUsdPerChallenge: 8, stagnationLimit: 5, costBasis: "actual" } },
      { id: "rec", name: "推荐", ac: "var(--green)", badge: "推荐", desc: "均衡 · 适合多数靶场", v: { poolSize: 8, maxRunsPerHour: 120, burstRuns: 120, maxCostUsdPerHour: 5, maxCostUsdPerChallenge: 15, stagnationLimit: 5, costBasis: "actual" } },
      { id: "full", name: "全力", ac: "var(--magenta)", desc: "高并发 · 烧钱换速度", v: { poolSize: 16, maxRunsPerHour: 240, burstRuns: 240, maxCostUsdPerHour: 10, maxCostUsdPerChallenge: 30, stagnationLimit: 0, costBasis: "actual" } },
    ];
    var MODES = [
      { id: "attended", ac: "var(--cyan)", ic: "◉", nm: "人主导", ds: "单题攻坚 · 额度宽可等待" },
      { id: "unattended", ac: "var(--amber)", ic: "◔", nm: "无人值守", ds: "定时任务 · 额度紧不等待" },
      { id: "bulk", ac: "var(--magenta)", ic: "⬢", nm: "靶场批量", ds: "并发池 · 一次打几十上百题" },
    ];
    var NUM_FIELDS = [
      { key: "poolSize", label: "并发池上限", min: 1, max: 32 },
      { key: "maxRunsPerHour", label: "令牌回填 /h", min: 1, max: 300 },
      { key: "burstRuns", label: "令牌桶容量", min: 1, max: 300 },
      { key: "maxCostUsdPerHour", label: "每小时成本墙 $", min: 0.5, max: 100 },
      { key: "maxCostUsdPerChallenge", label: "整批成本墙 $", min: 1, max: 300 },
      { key: "stagnationLimit", label: "停滞熔断轮数", min: 0, max: 10 },
    ];

    function fetchJson(url, opts) {
      return fetch(url, opts).then(function (r) { return r.json(); });
    }
    function hasNums(o) {
      return NUMKEYS.some(function (k) { return o[k] !== undefined && o[k] !== "" && o[k] !== null; });
    }
    function tierOf(o) {
      if (!hasNums(o)) return "follow";
      for (var i = 0; i < BUNDLES.length; i++) {
        var b = BUNDLES[i];
        var same = NUMKEYS.every(function (k) { return Number(o[k]) === b.v[k]; });
        if (same) return b.id;
      }
      return "custom";
    }
    function normalize(o) {
      var out = {};
      if (o.mode) out.mode = o.mode;
      if (o.tier) out.tier = o.tier;
      if (o.flagAlert) out.flagAlert = true;
      out.autoOpenPane = o.autoOpenPane !== false;
      out.currency = o.currency === "USD" ? "USD" : "CNY";
      out.usdToCny = Number(o.usdToCny) > 0 ? Number(o.usdToCny) : 7.2;
      if (o.costBasis === "actual" || o.costBasis === "estimate") out.costBasis = o.costBasis;
      NUMKEYS.forEach(function (k) {
        if (o[k] !== undefined && o[k] !== "" && o[k] !== null) out[k] = Number(o[k]);
      });
      return out;
    }
    function fmtNums(o, money, sym) {
      if (!hasNums(o)) return "跟随配置 / mode 预设";
      return "并发 " + o.poolSize + " · " + o.maxRunsPerHour + " 单/h · 桶 " + o.burstRuns +
        " · " + sym + money(o.maxCostUsdPerHour).toFixed(0) + "/h · 整批 " + sym + money(o.maxCostUsdPerChallenge).toFixed(0) +
        " · 熔断 " + (Number(o.stagnationLimit) === 0 ? "关" : o.stagnationLimit + " 轮") +
        " · 口径 " + (o.costBasis === "actual" ? "DeepSeek 实际近似" : "Anthropic 估算");
    }

    // ── 悬浮提示：命令式挂到 body，避免祖先 transform/stacking 影响 fixed 定位 ──
    var tipEl = null;
    var tipTimer = null;
    function ensureTip() {
      if (tipEl) return tipEl;
      tipEl = document.createElement("div");
      tipEl.className = "mw-tip";
      tipEl.style.display = "none";
      document.body.appendChild(tipEl);
      return tipEl;
    }
    function showTip(text, rect) {
      var el = ensureTip();
      clearTimeout(tipTimer);
      tipTimer = setTimeout(function () {
        el.textContent = text;
        el.style.display = "block";
        var x = Math.max(130, Math.min(window.innerWidth - 130, rect.left + rect.width / 2));
        var y = Math.max(70, rect.top - 8);
        el.style.left = x + "px";
        el.style.top = y + "px";
      }, 140);
    }
    function hideTip() {
      clearTimeout(tipTimer);
      if (tipEl) tipEl.style.display = "none";
    }
    function Tip(props) {
      function enter(e) { showTip(props.text, e.currentTarget.getBoundingClientRect()); }
      function leave() { hideTip(); }
      React.useEffect(function () { return hideTip; }, []);
      return React.cloneElement(props.children, {
        onMouseEnter: enter, onMouseLeave: leave, onFocus: enter, onBlur: leave,
      });
    }

    function WorkbenchPanel() {
      var loaded = React.useState(null);
      var stored = loaded[0], setStored = loaded[1];
      var d = React.useState(null);
      var draft = d[0], setDraft = d[1];
      var l = React.useState(null);
      var ledger = l[0], setLedger = l[1];
      var sv = React.useState("idle");
      var saveState = sv[0], setSaveState = sv[1];
      var fg = React.useState([]);
      var flags = fg[0], setFlags = fg[1];

      React.useEffect(function () {
        ensureStyle();
        var alive = true;
        function load() {
          fetchJson("/api/muteki/settings").then(function (j) {
            if (!alive || !j || !j.ok) return;
            var s = j.data.settings || {};
            setStored(s);
            setDraft(function (prev) {
              if (prev) return prev; // 已有草稿不覆盖
              var base = { mode: s.mode || "attended", autoOpenPane: s.autoOpenPane !== false, flagAlert: s.flagAlert === true, currency: s.currency === "USD" ? "USD" : "CNY", usdToCny: Number(s.usdToCny) > 0 ? Number(s.usdToCny) : 7.2 };
              if (s.tier) base.tier = s.tier;
              if (hasNums(s)) { NUMKEYS.forEach(function (k) { if (s[k] !== undefined) base[k] = s[k]; }); if (s.costBasis) base.costBasis = s.costBasis; }
              // 无覆盖时默认「人主导 + 跟随预设」：推荐档只以 badge 标示，
              // 点选档位才写入 mode=bulk，避免「选了档位却仍跑 attended」的静默陷阱。
              return base;
            });
          }).catch(function () {});
          fetchJson("/api/muteki/ledger").then(function (j) {
            if (alive && j && j.ok) setLedger(j.data);
          }).catch(function () {});
        }
        load();
        var t = setInterval(load, 5000);
        return function () { alive = false; clearInterval(t); };
      }, []);

      // 首解即报：开启时 2s 轮询旗标留痕，横幅直接显示 flag 值（不用点子代理）
      var flagAlertOn = !!(draft && draft.flagAlert);
      React.useEffect(function () {
        if (!flagAlertOn) { setFlags([]); return; }
        var alive = true;
        function pull() {
          fetchJson("/api/muteki/flags").then(function (j) {
            if (alive && j && j.ok) setFlags(j.data.flags || []);
          }).catch(function () {});
        }
        pull();
        var t = setInterval(pull, 2000);
        return function () { alive = false; clearInterval(t); };
      }, [flagAlertOn]);

      if (!draft) return h("div", { className: "mw-root" }, h("div", { className: "mw-empty" }, "正在连接工作台服务…"));

      function set(k, v) {
        setDraft(Object.assign({}, draft, (function () { var o = {}; o[k] = v; return o; })()));
        setSaveState("idle");
      }
      function clearNums() {
        var next = Object.assign({}, draft);
        NUMKEYS.forEach(function (k) { delete next[k]; });
        delete next.costBasis;
        delete next.tier;
        setDraft(next);
        setSaveState("idle");
      }
      // 切模式：离开 bulk 时清掉 tier，避免留下无意义的档位标记。
      function setMode(id) {
        var next = Object.assign({}, draft, { mode: id });
        if (id !== "bulk") delete next.tier;
        setDraft(next);
        setSaveState("idle");
      }
      // 选档位 = 进入靶场批量 + 套用该档推荐值 + 记录 tier（orchestrator 按 tier 取预设）。
      // UI 档位 id（safe/rec/full）映射到 orchestrator 的 BULK_TIERS key（lite/standard/max）。
      var TIER_KEY = { safe: "lite", rec: "standard", full: "max" };
      function applyTier(b) {
        var next = Object.assign({}, draft);
        NUMKEYS.forEach(function (k) { delete next[k]; });
        Object.assign(next, b.v);
        next.mode = "bulk";
        next.tier = TIER_KEY[b.id] || "standard";
        setDraft(next);
        setSaveState("idle");
      }
      var numsTier = tierOf(draft);
      var activeTier = draft.mode === "bulk" ? numsTier : "follow";
      var rate = Number(draft.usdToCny) > 0 ? Number(draft.usdToCny) : 7.2;
      var isCny = draft.currency !== "USD";
      var sym = isCny ? "¥" : "$";
      function money(usd) { return isCny ? Number(usd) * rate : Number(usd); }
      var dirty = stored ? JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(stored)) : true;

      function save() {
        if (!dirty || saveState === "saving") return;
        setSaveState("saving");
        fetchJson("/api/muteki/settings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(normalize(draft)),
        }).then(function (j) {
          if (j && j.ok) {
            setStored(j.data.settings);
            setSaveState("done");
            setTimeout(function () { setSaveState("idle"); }, 1600);
          } else setSaveState("idle");
        }).catch(function () { setSaveState("idle"); });
      }

      var totals = (ledger && ledger.totals) || {};
      var buckets = (ledger && ledger.buckets) || {};
      var chalKeys = Object.keys(totals);
      var maxTok = 1;
      chalKeys.forEach(function (c) {
        var b = buckets[c];
        var t = b && typeof b.tokens === "number" ? b.tokens : (typeof b === "number" ? b : 0);
        if (t > maxTok) maxTok = t;
      });

      return h("div", { className: "mw-root" },
        h("div", { className: "mw-scroll" },
        h("div", { className: "mw-sec", style: { animationDelay: "0ms" } },
          h("div", { className: "mw-eyebrow" }, h("span", { className: "mw-dot" }), "MUTEKI · SWARM CONSOLE"),
          h("div", { className: "mw-title" }, "蜂群工作台"),
          h("div", { className: "mw-sub" }, "选档位即可，无需理解每个数字；保存后下一次派单立即生效，不用重启。"),
        ),

        flagAlertOn && flags.length > 0
          ? h("div", { className: "mw-flags" },
              h("div", { className: "mw-flags-h" }, "🚩 首解即报 · 已解出 " + flags.length + " 题"),
              flags.map(function (f, i) {
                return h("div", { className: "mw-flag", key: (f.ts || 0) + "-" + i },
                  h("span", { className: "v" }, f.value),
                  h("span", { className: "meta" }, (f.challenge || "") + " · " + (f.ts ? new Date(f.ts).toLocaleTimeString() : "")));
              }))
          : null,

        h("div", { className: "mw-sec", style: { animationDelay: "60ms" } },
          h("div", { className: "mw-sec-h" }, h("span", { className: "idx" }, "01"), "运行模式", h("span", { className: "hint" }, "决定额度与并行形状")),
          h("div", { className: "mw-modes" }, MODES.map(function (m) {
            return h(Tip, { key: m.id, text: m.nm + "：" + m.ds + "。点击切换运行模式。" },
              h("button", {
                className: "mw-mode" + (draft.mode === m.id ? " on" : ""),
                style: { "--ac": m.ac },
                onClick: function () { setMode(m.id); },
              }, h("div", { className: "ic" }, m.ic), h("div", { className: "nm" }, m.nm), h("div", { className: "ds" }, m.ds)));
          })),
          h(Tip, { text: "不写 mode 覆盖，沿用 profile 配置里的 mode（当前多为 attended）。" },
            h("button", { className: "mw-follow" + (draft.mode === "" ? " on" : ""), onClick: function () { setMode(""); } }, "跟随配置")),
        ),

        h("div", { className: "mw-sec", style: { animationDelay: "120ms" } },
          h("div", { className: "mw-sec-h" }, h("span", { className: "idx" }, "02"), "强度档位", h("span", { className: "hint" }, "点档位 = 切到靶场批量并套用推荐值")),
          h("div", { className: "mw-tiers" }, BUNDLES.map(function (b) {
            return h(Tip, { key: b.id, text: b.name + "档：" + b.desc + "。点击即切到靶场批量模式。并发 " + b.v.poolSize + "、回填 " + b.v.maxRunsPerHour + " 单/h、成本墙 " + sym + money(b.v.maxCostUsdPerHour).toFixed(0) + "/h、整批 " + sym + money(b.v.maxCostUsdPerChallenge).toFixed(0) + "。" },
              h("button", {
                className: "mw-tier" + (activeTier === b.id ? " on" : ""),
                style: { "--ac": b.ac },
                onClick: function () { applyTier(b); },
              },
                h("div", { className: "nm" }, b.name, b.badge ? h("span", { className: "badge" }, b.badge) : null),
                h("div", { className: "ds" }, b.desc),
                h("div", { className: "nums" }, "并发 " + b.v.poolSize + " · " + sym + money(b.v.maxCostUsdPerHour).toFixed(0) + "/h")));
          })),
          h("div", { style: { marginTop: 8, display: "flex", gap: 8, alignItems: "center" } },
            h(Tip, { text: "清除所有数字覆盖与档位标记，回到 mode 预设的默认额度。" },
              h("button", { className: "mw-follow" + (!hasNums(draft) ? " on" : ""), onClick: clearNums }, "跟随预设")),
            numsTier === "custom" ? h("span", { className: "mw-dirty" }, "自定义中") : null),
          hasNums(draft) && draft.mode !== "bulk"
            ? h("div", { className: "mw-note" },
                "当前不是靶场批量：并发池不启用，上面的数字只作为额度/并发覆盖生效。点任一档位可一键进入批量。")
            : null,
          h("div", { className: "mw-readout" }, "当前生效意图 → ", h("b", null, (draft.mode === "bulk" ? "靶场批量 · " : draft.mode === "unattended" ? "无人值守 · " : draft.mode === "attended" ? "人主导 · " : "跟随配置 · ") + fmtNums(draft, money, sym))),
        ),

        h("div", { className: "mw-sec", style: { animationDelay: "180ms" } },
          h("div", { className: "mw-sec-h" }, h("span", { className: "idx" }, "03"), "行为"),
          h(Tip, { text: "派单时自动在右侧打开子代理实时对话 pane（最多 8 个），不用手动点目录。关闭则恢复宿主默认。" },
            h("div", { className: "mw-row" },
              h("div", null, h("div", { className: "lb" }, "派单自动开实时 pane"), h("div", { className: "ds" }, "子代理一开工就能在旁边看到它在干什么")),
              h("button", {
                className: "mw-switch" + (draft.autoOpenPane !== false ? " on" : ""),
                role: "switch", "aria-checked": draft.autoOpenPane !== false,
                onClick: function () { set("autoOpenPane", draft.autoOpenPane === false); },
              }))),
          h(Tip, { text: "首解即报（抢速度）：任一 worker 写出 flag，工作台顶部横幅立刻显示 flag 值，不用等主会话收束、不用点子代理；人主导模式同时把 flag 探测加密到 1s 并提示主会话跳过 review 直接报 flag。" },
            h("div", { className: "mw-row", style: { marginTop: 8 } },
              h("div", null, h("div", { className: "lb" }, "首解即报（抢速度）"), h("div", { className: "ds" }, "flag 一解出就在顶部横幅显示，比赛不用翻子代理")),
              h("button", {
                className: "mw-switch" + (draft.flagAlert ? " on" : ""),
                role: "switch", "aria-checked": !!draft.flagAlert,
                onClick: function () { set("flagAlert", !draft.flagAlert); },
              }))),
          h("div", { className: "mw-row", style: { marginTop: 8 } },
            h("div", null, h("div", { className: "lb" }, "计价货币"), h("div", { className: "ds" }, "DSH/DeepSeek 按人民币计费；内部估算仍为美元标价，按汇率换算显示")),
            h("div", { style: { marginLeft: "auto", display: "flex", gap: 6 } },
              h(Tip, { text: "以人民币显示成本墙与账本（1 USD ≈ " + rate + " CNY）。" },
                h("button", { className: "mw-follow" + (isCny ? " on" : ""), style: { marginTop: 0 }, onClick: function () { set("currency", "CNY"); } }, "¥ 人民币")),
              h(Tip, { text: "以美元显示（Anthropic 标价口径）。" },
                h("button", { className: "mw-follow" + (!isCny ? " on" : ""), style: { marginTop: 0 }, onClick: function () { set("currency", "USD"); } }, "$ 美元")))),
          h("div", { className: "mw-note" }, "价格预算仅为估算，不代表实际使用。"),
        ),

        h("div", { className: "mw-sec", style: { animationDelay: "240ms" } },
          h("details", { className: "mw-adv" },
            h("summary", null, "高级 · 逐项微调（一般不用动）"),
            h("div", { className: "body" }, NUM_FIELDS.map(function (f) {
              var isCost = f.key.indexOf("Cost") >= 0;
              var shown = draft[f.key] === undefined ? "" : (isCost ? money(draft[f.key]).toFixed(2) : draft[f.key]);
              return h("label", { className: "mw-num", key: f.key },
                h("span", { className: "lb" }, f.label + (isCost ? "（" + sym + "）" : "")),
                h("input", {
                  type: "number", name: f.key, min: f.min, max: f.max, step: isCost ? 0.5 : 1,
                  value: shown,
                  placeholder: "预设",
                  onChange: function (e) {
                    var raw = e.target.value;
                    if (raw === "") { set(f.key, ""); return; }
                    var n = Number(raw);
                    set(f.key, isCost && isCny ? n / rate : n);
                  },
                }));
            }).concat(isCny ? [h("label", { className: "mw-num", key: "rate" },
              h("span", { className: "lb" }, "汇率 USD→CNY"),
              h("input", {
                type: "number", name: "usdToCny", min: 1, max: 20, step: 0.1,
                value: draft.usdToCny === undefined ? 7.2 : draft.usdToCny,
                onChange: function (e) { set("usdToCny", e.target.value === "" ? 7.2 : Number(e.target.value)); },
              }))] : []).concat([
              h("label", { className: "mw-num", key: "basis" },
                h("span", { className: "lb" }, "成本口径"),
                h("select", {
                  name: "costBasis",
                  value: draft.costBasis === "actual" ? "actual" : "estimate",
                  onChange: function (e) { set("costBasis", e.target.value); },
                },
                  h("option", { value: "estimate" }, "Anthropic 估算"),
                  h("option", { value: "actual" }, "DeepSeek 实际近似"))),
              h("div", { className: "mw-span", key: "modelnote" },
                "其它模型（Claude CLI 等）按 estimate-anthropic 口径记账、DSH 子代理按墙钟估算，不做逐模型定价；口径只影响闸门与显示比哪个数。"),
            ])))),

        h("div", { className: "mw-sec", style: { animationDelay: "300ms" } },
          h("div", { className: "mw-sec-h" }, h("span", { className: "idx" }, "04"), "账本快照", h("span", { className: "hint" }, "5 秒刷新")),
          chalKeys.length === 0
            ? h("div", { className: "mw-empty" }, "还没有派单记录；跑一把 muteki_run 后这里会按题显示花费与令牌。")
            : h("div", { className: "mw-stats" }, chalKeys.map(function (c) {
                var t = totals[c] || {};
                var b = buckets[c];
                var tok = b && typeof b.tokens === "number" ? b.tokens : (typeof b === "number" ? b : 0);
                return h("div", { className: "mw-stat", key: c },
                  h("div", { className: "ch" }, c, h("span", { className: "tag" }, "题")),
                  h("div", { className: "grid" },
                    h("div", { className: "cell" }, h("div", { className: "k" }, "派单"), h("div", { className: "v" }, t.runs || 0)),
                    h("div", { className: "cell" }, h("div", { className: "k" }, "DeepSeek 估算"), h("div", { className: "v cost" }, sym + money(t.usdActual !== undefined ? t.usdActual : (t.usdEstimate || 0) * 0.1).toFixed(2))),
                    h("div", { className: "cell" }, h("div", { className: "k" }, "剩余令牌"), h("div", { className: "v tok" }, Math.round(tok)))),
                  h("div", { className: "mw-bar" }, h("i", { style: { width: Math.max(4, Math.min(100, (tok / maxTok) * 100)) + "%" } })));
              }))),
        ),

        h("div", { className: "mw-savebar" },
          h("span", { className: "mw-dirty" + (dirty ? "" : " clean") }, dirty ? "● 有未保存改动" : "○ 已同步"),
          h(Tip, { text: dirty ? "把当前档位/模式写入 settings.json，下一次额度判定立即生效（不用重启 DSH）。" : "当前没有改动，无需保存。" },
            h("button", {
              className: "mw-save" + (saveState === "done" ? " done" : ""),
              disabled: !dirty || saveState === "saving",
              onClick: save,
            }, saveState === "done" ? "✓ 已应用" : saveState === "saving" ? "保存中…" : "保存并应用")))
      );
    }

    function TabTitle() {
      return h("span", null, "Muteki 工作台");
    }

    exports.apply = function (ctx) {
      ensureStyle();
      // 会话头部胶囊：点「Muteki 蜂群」旁「工作台」→ 右侧栏弹工作台。
      // 必须定义在 apply 内：open 闭包引用 ctx（apply 参数）。
      function WorkbenchCapsule(props) {
        var preset = props.useSessions ? props.useSessions(function (state) {
          var s = state.byId && state.byId[props.sessionId];
          var val = s && s.projectionValues && s.projectionValues.agentPreset;
          return typeof val === "string" ? val : undefined;
        }) : undefined;
        if (preset === undefined || preset !== "muteki") return null;
        function open(e) {
          e.preventDefault();
          e.stopPropagation();
          var sid = props.sessionId;
          if (ctx.sidebarRight) {
            if (sid && typeof ctx.sidebarRight.openTabIn === "function") {
              try { ctx.sidebarRight.openTabIn(sid, "muteki"); } catch (err) { console.error("[muteki-workbench] openTabIn failed:", err); }
            }
            if (typeof ctx.sidebarRight.openTab === "function") {
              try { ctx.sidebarRight.openTab("muteki"); } catch (err) { console.error("[muteki-workbench] openTab failed:", err); }
            }
            if (typeof ctx.sidebarRight.isExpanded === "function" && !ctx.sidebarRight.isExpanded()) {
              try { ctx.sidebarRight.toggleExpanded(); } catch (err) { console.error("[muteki-workbench] toggleExpanded failed:", err); }
            }
          }
        }
        return h("button", {
          onClick: open, title: "打开 Muteki 工作台",
          style: {
            display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 9px", marginLeft: 6,
            border: "1px solid var(--dsw-alias-state-success-primary,#34d399)", borderRadius: 999,
            background: "transparent", color: "var(--dsw-alias-state-success-primary,#34d399)",
            fontSize: 11, lineHeight: "16px", cursor: "pointer",
          },
        }, "工作台");
      }

      if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === "function") {
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: "muteki:workbench", kind: "muteki",
            title: function () { return "Muteki 工作台"; },
          });
        }, "muteki-workbench: sidebar tab definition");
      }
      ctx.slots.inject("sidebar.right.pane.tab", function* () {
        yield ctx.slots.register({ name: "sidebar.right.pane.tab", key: "muteki:workbench" }, WorkbenchPanel);
        yield ctx.slots.register({ name: "sidebar.right.pane.tab", key: "muteki" }, WorkbenchPanel);
      });
      ctx.slots.inject("sidebar.right.pane.tab.title", function* () {
        yield ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: "muteki:workbench" }, TabTitle);
        yield ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: "muteki" }, TabTitle);
      });
      ctx.slots.inject("conversation.session.header.actions", function* () {
        yield ctx.slots.register({ name: "conversation.session.header.actions", id: "muteki:workbench", order: -9 }, WorkbenchCapsule);
      });

      // 派单自动开实时 pane：监听 subagentCatalog 新增条目。
      var autoOpen = true;
      var known = {};
      var opened = 0;
      var lastSid = null;
      ctx.effect(function () {
        var settingsTimer = setInterval(function () {
          fetchJson("/api/muteki/settings").then(function (j) {
            if (j && j.ok) autoOpen = j.data.settings.autoOpenPane !== false;
          }).catch(function () {});
        }, 5000);
        var pollTimer = setInterval(function () {
          if (!autoOpen || !ctx.sidebarRight || !ctx.sessions) return;
          var sid = ctx.sidebarRight.mounted && ctx.sidebarRight.mounted.getSnapshot ? ctx.sidebarRight.mounted.getSnapshot() : null;
          if (!sid) return;
          if (sid !== lastSid) { lastSid = sid; opened = 0; }
          var snap = ctx.sessions.list.getSnapshot();
          var proj = snap.projectionsBySession && snap.projectionsBySession[sid];
          var catalog = (proj && proj.values && proj.values.subagentCatalog) || [];
          if (!known[sid]) {
            known[sid] = {};
            catalog.forEach(function (e) { known[sid][e.id] = true; });
            return;
          }
          catalog.forEach(function (entry) {
            if (known[sid][entry.id] || entry.mode === "external") return;
            known[sid][entry.id] = true;
            if (opened >= 8) return;
            opened += 1;
            try {
              ctx.sidebarRight.openResource(
                "dsh-resource://subagentchat/session/" + encodeURIComponent(entry.id) +
                  "?parent=" + encodeURIComponent(sid) + "&mode=" + encodeURIComponent(entry.mode),
                { kind: "subagentchat", preferNewPane: true },
              );
            } catch (e) { /* pane 开失败不影响派单 */ }
          });
        }, 2000);
        return function () { clearInterval(settingsTimer); clearInterval(pollTimer); };
      }, "muteki-workbench: auto-open subagent panes");
    };

    return module.exports;
  },
});