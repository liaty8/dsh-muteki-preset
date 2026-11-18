// muteki-workbench 浏览器半：右侧栏「Muteki 工作台」页签。
// 滑杆/输入调 mode/tier/并发/成本墙 → POST /api/muteki/settings（orchestrator 运行时生效，不用重启）；
// 可选：派单时自动打开子代理实时对话 pane（补上宿主「点目录才开」的默认行为）。
// 契约对照 @adwmc/helm-d client.js：sidebarRightTabs.register + sidebar.right.pane.tab slot。
window.__ModuleLoader__.load({
  id: "muteki-workbench",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    exports.inject = ["slots", "sidebarRight", "sidebarRightTabs", "sessions"];

    var NUM_FIELDS = [
      { key: "poolSize", label: "并发池上限（bulk）", min: 1, max: 16, step: 1 },
      { key: "maxRunsPerHour", label: "令牌回填 次/小时", min: 1, max: 300, step: 1 },
      { key: "burstRuns", label: "令牌桶容量", min: 1, max: 300, step: 1 },
      { key: "maxCostUsdPerHour", label: "每小时成本墙 $", min: 0.5, max: 100, step: 0.5 },
      { key: "maxCostUsdPerChallenge", label: "整题/整批成本墙 $", min: 1, max: 300, step: 1 },
      { key: "stagnationLimit", label: "停滞熔断轮数（0=关）", min: 0, max: 10, step: 1 },
    ];

    function fetchJson(url, opts) {
      return fetch(url, opts).then(function (r) { return r.json(); });
    }

    function Field(props) {
      var f = props.field;
      var value = props.value;
      return h("label", { style: { display: "block", marginBottom: 10 } },
        h("div", { style: { fontSize: 12, opacity: 0.8, marginBottom: 2 } }, f.label),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("input", {
            type: "range", min: f.min, max: f.max, step: f.step,
            value: value === "" ? f.min : Number(value),
            style: { flex: 1 },
            onChange: function (e) { props.onChange(f.key, e.target.value); },
          }),
          h("input", {
            type: "number", min: f.min, max: f.max, step: f.step,
            value: value, placeholder: "预设",
            style: { width: 70 },
            onChange: function (e) { props.onChange(f.key, e.target.value); },
          }),
          h("button", {
            title: "清空=跟随 patch/mode 预设",
            onClick: function () { props.onChange(f.key, ""); },
          }, "×"),
        ),
      );
    }

    function WorkbenchPanel() {
      var s = React.useState(null);
      var settings = s[0], setSettings = s[1];
      var l = React.useState(null);
      var ledger = l[0], setLedger = l[1];
      var m = React.useState("");
      var note = m[0], setNote = m[1];

      React.useEffect(function () {
        var alive = true;
        function load() {
          fetchJson("/api/muteki/settings").then(function (j) {
            if (alive && j && j.ok) setSettings(Object.assign({ autoOpenPane: true }, j.data.settings));
          }).catch(function () {});
          fetchJson("/api/muteki/ledger").then(function (j) {
            if (alive && j && j.ok) setLedger(j.data);
          }).catch(function () {});
        }
        load();
        var timer = setInterval(load, 5000);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      if (!settings) return h("div", { style: { padding: 12 } }, "加载工作台…（需要 muteki-workbench 服务端路由）");

      function set(key, value) {
        setSettings(Object.assign({}, settings, (function () { var o = {}; o[key] = value; return o; })()));
      }
      function save() {
        var body = {};
        Object.keys(settings).forEach(function (k) {
          if (settings[k] !== "" && settings[k] !== undefined && settings[k] !== null) body[k] = settings[k];
        });
        fetchJson("/api/muteki/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then(function (j) {
          setNote(j && j.ok ? "已保存，下一次额度判定生效（不用重启）" : "保存失败：" + (j && j.error));
        }).catch(function (e) { setNote("保存失败：" + e); });
      }

      var totals = (ledger && ledger.totals) || {};
      var buckets = (ledger && ledger.buckets) || {};
      return h("div", { style: { padding: 12, fontSize: 13 } },
        h("div", { style: { fontWeight: 600, marginBottom: 8 } }, "Muteki 工作台"),
        h("label", { style: { display: "block", marginBottom: 8 } },
          h("div", { style: { fontSize: 12, opacity: 0.8 } }, "mode"),
          h("select", {
            value: settings.mode || "",
            onChange: function (e) { set("mode", e.target.value); },
          },
            h("option", { value: "" }, "跟随 patch"),
            h("option", { value: "attended" }, "attended 人主导单题"),
            h("option", { value: "unattended" }, "unattended 无人值守"),
            h("option", { value: "bulk" }, "bulk 靶场批量"),
          ),
        ),
        h("label", { style: { display: "block", marginBottom: 8 } },
          h("div", { style: { fontSize: 12, opacity: 0.8 } }, "tier（仅 bulk）"),
          h("select", {
            value: settings.tier || "",
            onChange: function (e) { set("tier", e.target.value); },
          },
            h("option", { value: "" }, "跟随 patch"),
            h("option", { value: "lite" }, "lite 池4"),
            h("option", { value: "standard" }, "standard 池8"),
            h("option", { value: "max" }, "max 池16"),
          ),
        ),
        NUM_FIELDS.map(function (f) {
          return h(Field, {
            key: f.key, field: f,
            value: settings[f.key] === undefined ? "" : String(settings[f.key]),
            onChange: set,
          });
        }),
        h("label", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 10 } },
          h("input", {
            type: "checkbox",
            checked: settings.autoOpenPane !== false,
            onChange: function (e) { set("autoOpenPane", e.target.checked); },
          }),
          "派单时自动打开子代理实时 pane（最多 8 个）",
        ),
        h("button", { onClick: save, style: { padding: "4px 14px" } }, "保存"),
        note ? h("div", { style: { marginTop: 6, fontSize: 12, opacity: 0.85 } }, note) : null,
        h("div", { style: { marginTop: 12, fontWeight: 600 } }, "账本快照"),
        h("div", { style: { fontSize: 12, opacity: 0.85, whiteSpace: "pre-wrap" } },
          ledger
            ? Object.keys(totals).map(function (ch) {
                var t = totals[ch] || {};
                var b = buckets[ch];
                var tokens = b && typeof b.tokens === "number" ? b.tokens : (typeof b === "number" ? b : "?");
                return ch + "：派单 " + (t.runs || 0) + " 次 / $" + Number(t.usdEstimate || 0).toFixed(2) + "（估算），令牌 " + tokens;
              }).join("\n") || "（还没有账本记录）"
            : "…"),
        h("div", { style: { marginTop: 8, fontSize: 11, opacity: 0.6 } },
          "空值=跟随 patch/mode 预设；覆盖写入 storageDir/settings.json，优先级高于 patch。"),
      );
    }

    function TabTitle() {
      return h("span", null, "Muteki 工作台");
    }

    exports.apply = function (ctx) {
      if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === "function") {
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: "muteki:workbench",
            kind: "muteki",
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

      // 派单自动开实时 pane：宿主默认要点目录才开，这里补上「派单即开」。
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
          var sid = ctx.sidebarRight.mounted && ctx.sidebarRight.mounted.getSnapshot
            ? ctx.sidebarRight.mounted.getSnapshot() : null;
          if (!sid) return;
          if (sid !== lastSid) { lastSid = sid; opened = 0; known[sid] = known[sid] || null; }
          var snap = ctx.sessions.list.getSnapshot();
          var proj = snap.projectionsBySession && snap.projectionsBySession[sid];
          var catalog = (proj && proj.values && proj.values.subagentCatalog) || [];
          if (!known[sid]) {
            // 首次见到该会话：已有子代理不补开，只跟踪新增
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