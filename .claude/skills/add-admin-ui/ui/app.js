// NanoClaw Admin — vanilla ES module.

const TABS = ["groups", "chats", "registered", "config", "webhooks"];

const state = {
  currentTab: "groups",
  data: { groups: null, chats: null, registered: null, config: null, webhooks: null },
  loading: { groups: false, chats: false, registered: false, config: false, webhooks: false },
  error: { groups: null, chats: null, registered: null, config: null, webhooks: null },
  filter: { groups: "", chats: "", registered: "", webhooks: "" },
  webhooks: {
    testMode: "message",
    testJid: "",
    testMessage: "",
    testTemplateId: "",
    testVars: {},
    editingTemplate: null,
  },
};

// ---------- fetch helper ----------

async function apiGet(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // leave as null
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function apiSend(method, path, body) {
  const init = {
    method,
    headers: { accept: "application/json" },
  };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // leave as null
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

function friendlyError(err) {
  const code = err?.body?.error;
  const map = {
    whatsapp_not_connected:
      "WhatsApp channel not connected — start the service and wait for the Baileys socket to open.",
    group_not_found: "Group not found (the bot may have been removed).",
    channel_not_installed: "That channel is not installed in this build.",
    jid_not_in_allowlist:
      "JID is not on the allowlist. Enable it in the Allowlist section.",
    missing_jid: "Missing JID.",
    missing_message_or_template_id: "Provide a message or pick a template.",
    template_not_found: "Template not found (deleted?).",
    missing_template: "Template body cannot be empty.",
    channel_not_connected: "The matching channel is not connected right now.",
    no_channel_for_jid: "No channel installed that can deliver to this JID.",
  };
  if (code && map[code]) return map[code];
  if (err?.status === 404) return "Not found.";
  if (err?.status === 503) return "Service unavailable — a channel is offline.";
  if (err?.status === 500) return "Server error while fetching data.";
  return err?.message || "Request failed.";
}

// ---------- DOM helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function truncate(str, max = 40) {
  const s = String(str ?? "");
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function copyButton(text, label = "Copy JID") {
  return h(
    "button",
    {
      class: "btn btn-icon",
      title: label,
      "aria-label": label,
      onclick: (e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(
          () => showToast("Copied to clipboard"),
          () => showToast("Copy failed"),
        );
      },
    },
    "\u29C9",
  );
}

function loadingEl(label = "Loading") {
  return h("div", { class: "loading" }, h("span", { class: "spinner" }), label + "\u2026");
}

function emptyEl(label) {
  return h("div", { class: "empty" }, label);
}

function bannerEl(message, variant = "warn") {
  return h("div", { class: "banner" + (variant === "error" ? " error" : "") }, message);
}

// ---------- formatting ----------

function formatUnix(seconds) {
  if (!seconds) return "-";
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms)) return "-";
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatRelative(iso) {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "-";
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const min = 60_000, hr = 3_600_000, day = 86_400_000;
  let val, unit;
  if (abs < min) return diff >= 0 ? "just now" : "in moments";
  if (abs < hr) { val = Math.round(abs / min); unit = "m"; }
  else if (abs < day) { val = Math.round(abs / hr); unit = "h"; }
  else if (abs < 30 * day) { val = Math.round(abs / day); unit = "d"; }
  else { return new Date(iso).toLocaleDateString(); }
  return diff >= 0 ? `${val}${unit} ago` : `in ${val}${unit}`;
}

// ---------- toast ----------

let toastTimer = null;
function showToast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 1500);
}

// ---------- channel pills ----------

async function refreshChannels() {
  const container = $("#channel-pills");
  container.textContent = "";
  try {
    const channels = await apiGet("/api/channels");
    if (!Array.isArray(channels) || channels.length === 0) {
      container.append(h("span", { class: "pill" }, h("span", { class: "dot" }), "no channels"));
      return;
    }
    for (const ch of channels) {
      container.append(
        h(
          "span",
          { class: "pill", dataset: { connected: String(!!ch.connected) } },
          h("span", { class: "dot" }),
          ch.name,
        ),
      );
    }
  } catch (err) {
    container.append(
      h("span", { class: "pill", dataset: { connected: "false" } }, h("span", { class: "dot" }), "channels unavailable"),
    );
    console.warn("channel fetch failed:", err);
  }
}

// ---------- tab switching ----------

function switchTab(name) {
  if (!TABS.includes(name)) return;
  state.currentTab = name;
  $$(".tab").forEach((t) => {
    t.setAttribute("aria-selected", String(t.dataset.tab === name));
  });
  $$(".panel").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.panel !== name);
  });
  if (state.data[name] == null && !state.loading[name]) {
    loadTab(name);
  }
}

// ---------- loaders ----------

const ENDPOINTS = {
  groups: "/api/groups",
  chats: "/api/chats",
  registered: "/api/registered",
  config: "/api/config",
};

async function loadTab(name) {
  if (name === "webhooks") return loadWebhooks();
  state.loading[name] = true;
  state.error[name] = null;
  render(name);
  try {
    const data = await apiGet(ENDPOINTS[name]);
    state.data[name] = data;
  } catch (err) {
    state.error[name] = friendlyError(err);
    state.data[name] = null;
  } finally {
    state.loading[name] = false;
    render(name);
  }
}

async function loadWebhooks() {
  state.loading.webhooks = true;
  state.error.webhooks = null;
  render("webhooks");
  try {
    const [wh, groups, chats] = await Promise.all([
      apiGet("/api/webhook"),
      apiGet("/api/groups").catch(() => []),
      apiGet("/api/chats").catch(() => []),
    ]);
    state.data.webhooks = {
      allowlist: Array.isArray(wh?.allowlist) ? wh.allowlist : [],
      templates:
        wh?.templates && typeof wh.templates === "object" ? wh.templates : {},
      groups: Array.isArray(groups) ? groups : [],
      chats: Array.isArray(chats) ? chats : [],
    };
  } catch (err) {
    state.error.webhooks = friendlyError(err);
    state.data.webhooks = null;
  } finally {
    state.loading.webhooks = false;
    render("webhooks");
  }
}

// ---------- rendering ----------

function render(name) {
  const body = $(`[data-body="${name}"]`);
  if (!body) return;
  body.textContent = "";

  if (state.loading[name]) {
    body.append(loadingEl());
    return;
  }
  if (state.error[name]) {
    body.append(bannerEl(state.error[name], "error"));
    return;
  }
  if (name === "groups") return renderGroups(body);
  if (name === "chats") return renderChats(body);
  if (name === "registered") return renderRegistered(body);
  if (name === "config") return renderConfig(body);
  if (name === "webhooks") return renderWebhooks(body);
}

function renderGroups(body) {
  const groups = state.data.groups || [];
  if (!groups.length) {
    body.append(emptyEl("No groups found."));
    return;
  }
  const q = state.filter.groups.trim().toLowerCase();
  const filtered = q
    ? groups.filter((g) => (g.subject || "").toLowerCase().includes(q))
    : groups;
  if (!filtered.length) {
    body.append(emptyEl("No groups match that filter."));
    return;
  }

  const tbody = h("tbody");
  for (const g of filtered) {
    const row = h(
      "tr",
      {
        class: "clickable",
        onclick: () => openGroupDrawer(g.jid),
      },
      h("td", {}, g.subject || h("span", { class: "mono" }, "(no subject)")),
      h(
        "td",
        { class: "mono" },
        h(
          "span",
          { class: "jid-cell" },
          h("span", { class: "truncate", title: g.jid }, g.jid),
          copyButton(g.jid),
        ),
      ),
      h("td", {}, String(g.size ?? "-")),
      h("td", {}, formatUnix(g.creation)),
    );
    tbody.append(row);
  }

  body.append(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Subject"),
            h("th", {}, "JID"),
            h("th", {}, "Size"),
            h("th", {}, "Created"),
          ),
        ),
        tbody,
      ),
    ),
  );
}

async function openGroupDrawer(jid) {
  const drawer = $("#drawer");
  const body = $("#drawer-body");
  drawer.setAttribute("aria-hidden", "false");
  body.textContent = "";
  body.append(loadingEl("Fetching group"));
  try {
    const meta = await apiGet(`/api/groups/${encodeURIComponent(jid)}`);
    renderGroupDrawer(meta);
  } catch (err) {
    body.textContent = "";
    body.append(bannerEl(friendlyError(err), "error"));
  }
}

function closeDrawer() {
  $("#drawer").setAttribute("aria-hidden", "true");
}

function renderGroupDrawer(meta) {
  const body = $("#drawer-body");
  body.textContent = "";
  $("#drawer-title").textContent = meta.subject || "Group";

  const meta_rows = [
    ["Subject", meta.subject || "-"],
    ["JID", h("span", { class: "mono" }, meta.id || meta.jid || "-")],
    ["Size", String(meta.size ?? (meta.participants?.length ?? "-"))],
    ["Created", formatUnix(meta.creation)],
    ["Owner", meta.owner ? h("span", { class: "mono" }, meta.owner) : "-"],
    ["Announce-only", meta.announce ? "Yes" : "No"],
    ["Locked (restrict)", meta.restrict ? "Yes" : "No"],
  ];

  const dl = h("dl", { class: "kv-grid" });
  for (const [k, v] of meta_rows) {
    dl.append(h("dt", {}, k), h("dd", {}, v));
  }
  body.append(h("h4", {}, "Metadata"), dl);

  if (meta.desc) {
    body.append(
      h("h4", {}, "Description"),
      h("div", { class: "banner" }, String(meta.desc)),
    );
  }

  const participants = Array.isArray(meta.participants) ? meta.participants : [];
  body.append(h("h4", {}, `Participants (${participants.length})`));
  if (!participants.length) {
    body.append(emptyEl("No participants returned."));
    return;
  }
  const tbody = h("tbody");
  for (const p of participants) {
    let badge = null;
    if (p.admin === "superadmin") {
      badge = h("span", { class: "badge badge-accent" }, "superadmin");
    } else if (p.admin === "admin") {
      badge = h("span", { class: "badge badge-success" }, "admin");
    }
    tbody.append(
      h(
        "tr",
        {},
        h(
          "td",
          { class: "mono" },
          h(
            "span",
            { class: "jid-cell" },
            h("span", { class: "truncate", title: p.id }, p.id),
            copyButton(p.id, "Copy participant JID"),
          ),
        ),
        h("td", {}, badge || h("span", { class: "badge" }, "member")),
      ),
    );
  }
  body.append(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "ID"), h("th", {}, "Role"))),
        tbody,
      ),
    ),
  );
}

function renderChats(body) {
  const chats = state.data.chats || [];
  if (!chats.length) {
    body.append(emptyEl("No chats yet."));
    return;
  }
  const q = state.filter.chats.trim().toLowerCase();
  const filtered = q
    ? chats.filter(
        (c) =>
          (c.name || "").toLowerCase().includes(q) ||
          (c.jid || "").toLowerCase().includes(q),
      )
    : chats;
  if (!filtered.length) {
    body.append(emptyEl("No chats match that filter."));
    return;
  }

  const tbody = h("tbody");
  for (const c of filtered) {
    tbody.append(
      h(
        "tr",
        {},
        h("td", {}, c.name || h("span", { class: "mono" }, "(unnamed)")),
        h(
          "td",
          { class: "mono" },
          h(
            "span",
            { class: "jid-cell" },
            h("span", { class: "truncate", title: c.jid }, c.jid),
            copyButton(c.jid),
          ),
        ),
        h("td", {}, h("span", { class: "badge" }, c.channel || "-")),
        h(
          "td",
          {},
          Number(c.is_group) === 1
            ? h("span", { class: "badge badge-accent" }, "group")
            : h("span", { class: "badge" }, "direct"),
        ),
        h("td", { title: c.last_message_time || "" }, formatRelative(c.last_message_time)),
      ),
    );
  }

  body.append(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Name"),
            h("th", {}, "JID"),
            h("th", {}, "Channel"),
            h("th", {}, "Type"),
            h("th", {}, "Last message"),
          ),
        ),
        tbody,
      ),
    ),
  );
}

function renderRegistered(body) {
  const raw = state.data.registered || {};
  const list = Object.values(raw);
  if (!list.length) {
    body.append(emptyEl("No registered chats yet."));
    return;
  }
  const q = state.filter.registered.trim().toLowerCase();
  const filtered = q
    ? list.filter(
        (r) =>
          (r.name || "").toLowerCase().includes(q) ||
          (r.jid || "").toLowerCase().includes(q),
      )
    : list;
  if (!filtered.length) {
    body.append(emptyEl("No registered chats match."));
    return;
  }

  const tbody = h("tbody");
  for (const r of filtered) {
    const tr = h(
      "tr",
      r.is_main ? { class: "is-main" } : {},
      h(
        "td",
        {},
        r.name || h("span", { class: "mono" }, "(unnamed)"),
        r.is_main ? " " : null,
        r.is_main ? h("span", { class: "badge badge-accent" }, "main") : null,
      ),
      h(
        "td",
        { class: "mono" },
        h(
          "span",
          { class: "jid-cell" },
          h("span", { class: "truncate", title: r.jid }, r.jid),
          copyButton(r.jid),
        ),
      ),
      h("td", { class: "mono" }, truncate(r.folder || "-", 40)),
      h("td", { class: "mono" }, r.trigger_pattern || "-"),
      h(
        "td",
        {},
        r.requires_trigger
          ? h("span", { class: "badge badge-warning" }, "Yes")
          : h("span", { class: "badge" }, "No"),
      ),
      h(
        "td",
        {},
        r.is_main
          ? h("span", { class: "badge badge-accent" }, "Yes")
          : h("span", { class: "badge" }, "No"),
      ),
      h("td", { title: r.added_at || "" }, formatRelative(r.added_at)),
    );
    tbody.append(tr);
  }

  body.append(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Name"),
            h("th", {}, "JID"),
            h("th", {}, "Folder"),
            h("th", {}, "Trigger"),
            h("th", {}, "Requires trigger"),
            h("th", {}, "Main"),
            h("th", {}, "Added"),
          ),
        ),
        tbody,
      ),
    ),
  );
}

function renderConfig(body) {
  const cfg = state.data.config || {};
  const keys = [
    "assistantName",
    "assistantHasOwnNumber",
    "defaultTrigger",
    "timezone",
    "adminPort",
    "storeDir",
    "dataDir",
    "installedChannels",
  ];

  const dl = h("dl", { class: "kv-grid" });
  for (const key of keys) {
    if (!(key in cfg)) continue;
    const v = cfg[key];
    let rendered;
    if (key === "installedChannels" && Array.isArray(v)) {
      rendered = h(
        "span",
        {},
        ...v.map((c) => h("span", { class: "badge badge-accent" }, c)),
      );
      if (!v.length) rendered = h("span", { class: "mono" }, "(none)");
    } else if (typeof v === "boolean") {
      rendered = h("span", { class: "badge" }, v ? "Yes" : "No");
    } else {
      rendered = h("span", { class: "mono" }, String(v ?? "-"));
    }
    dl.append(h("dt", {}, key), h("dd", {}, rendered));
  }

  // Surface any extra keys the server sent that we didn't explicitly list.
  for (const [k, v] of Object.entries(cfg)) {
    if (keys.includes(k)) continue;
    dl.append(
      h("dt", {}, k),
      h("dd", {}, h("span", { class: "mono" }, typeof v === "object" ? JSON.stringify(v) : String(v))),
    );
  }

  body.append(dl);
}

// ---------- webhooks ----------

function extractVars(body) {
  const s = String(body ?? "");
  const out = [];
  const seen = new Set();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

function webhookErrorText(err, fallback) {
  const code = err?.body?.error;
  const detail = err?.body?.detail;
  const msg = friendlyError(err);
  if (msg && msg !== "Request failed.") {
    return detail && !code ? `${msg}: ${detail}` : msg;
  }
  if (code) return detail ? `${code}: ${detail}` : code;
  return fallback;
}

function renderWebhooks(body) {
  const d = state.data.webhooks || {
    allowlist: [],
    templates: {},
    groups: [],
    chats: [],
  };
  body.append(
    renderWebhookTester(d),
    h(
      "div",
      { class: "wh-grid" },
      renderWebhookAllowlist(d),
      renderWebhookTemplates(d),
    ),
  );
}

function renderWebhookTester(d) {
  const section = h("section", { class: "wh-section" });
  section.append(
    h("h3", {}, "Test webhook"),
    h(
      "p",
      { class: "panel-sub" },
      "Send a one-off message or render a template to an allowlisted JID.",
    ),
  );

  const allowlist = Array.isArray(d.allowlist) ? d.allowlist : [];
  const templates = d.templates || {};
  const tpl = state.webhooks;

  if (!allowlist.length) {
    section.append(
      bannerEl(
        "Allowlist is empty — add a JID below before you can send.",
        "warn",
      ),
    );
  }

  const form = h("div", { class: "wh-form" });

  // JID select
  const jidSelect = h("select", {
    onchange: (e) => {
      tpl.testJid = e.target.value;
    },
  });
  jidSelect.append(h("option", { value: "" }, "— choose JID —"));
  for (const jid of allowlist) {
    const opt = h("option", { value: jid }, jid);
    if (tpl.testJid === jid) opt.selected = true;
    jidSelect.append(opt);
  }
  if (!allowlist.length) jidSelect.disabled = true;
  form.append(h("label", {}, "JID", jidSelect));

  // Mode radios
  const modeWrap = h(
    "div",
    { class: "wh-mode" },
    h(
      "label",
      {},
      h("input", {
        type: "radio",
        name: "wh-test-mode",
        value: "message",
        checked: tpl.testMode === "message",
        onchange: () => {
          tpl.testMode = "message";
          render("webhooks");
        },
      }),
      " Message",
    ),
    h(
      "label",
      {},
      h("input", {
        type: "radio",
        name: "wh-test-mode",
        value: "template",
        checked: tpl.testMode === "template",
        onchange: () => {
          tpl.testMode = "template";
          render("webhooks");
        },
      }),
      " Template",
    ),
  );
  form.append(modeWrap);

  if (tpl.testMode === "message") {
    form.append(
      h(
        "label",
        {},
        "Message",
        h("textarea", {
          placeholder: "Plain text message...",
          oninput: (e) => {
            tpl.testMessage = e.target.value;
          },
        }, tpl.testMessage || ""),
      ),
    );
  } else {
    const templateIds = Object.keys(templates);
    const tplSelect = h("select", {
      onchange: (e) => {
        tpl.testTemplateId = e.target.value;
        tpl.testVars = {};
        render("webhooks");
      },
    });
    tplSelect.append(h("option", { value: "" }, "— choose template —"));
    for (const id of templateIds) {
      const opt = h("option", { value: id }, id);
      if (tpl.testTemplateId === id) opt.selected = true;
      tplSelect.append(opt);
    }
    if (!templateIds.length) tplSelect.disabled = true;
    form.append(h("label", {}, "Template", tplSelect));

    const chosen = templates[tpl.testTemplateId];
    if (chosen) {
      const vars = extractVars(chosen.template || "");
      if (vars.length) {
        const varsWrap = h("div", { class: "wh-form" });
        for (const vname of vars) {
          const input = h("input", {
            type: "text",
            placeholder: vname,
            value: tpl.testVars[vname] || "",
            oninput: (e) => {
              tpl.testVars[vname] = e.target.value;
            },
          });
          varsWrap.append(h("label", {}, vname, input));
        }
        form.append(varsWrap);
      } else {
        form.append(
          h("p", { class: "panel-sub" }, "Template has no variables."),
        );
      }
    }
  }

  const sendBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        const jid = tpl.testJid;
        if (!jid) {
          showToast("Pick a JID first");
          return;
        }
        let payload;
        if (tpl.testMode === "message") {
          const msg = (tpl.testMessage || "").trim();
          if (!msg) {
            showToast("Message is empty");
            return;
          }
          payload = { jid, message: msg };
        } else {
          if (!tpl.testTemplateId) {
            showToast("Pick a template first");
            return;
          }
          payload = {
            jid,
            template_id: tpl.testTemplateId,
            variables: { ...tpl.testVars },
          };
        }
        sendBtn.disabled = true;
        try {
          const res = await apiSend("POST", "/api/webhook", payload);
          const bytes = res?.bytes != null ? ` (${res.bytes} bytes)` : "";
          const channel = res?.channel ? ` via ${res.channel}` : "";
          showToast(`Sent${channel}${bytes}`);
        } catch (err) {
          showToast(webhookErrorText(err, "Send failed"));
        } finally {
          sendBtn.disabled = false;
        }
      },
    },
    "Send",
  );

  form.append(h("div", { class: "wh-actions" }, sendBtn));
  section.append(form);
  return section;
}

function renderWebhookAllowlist(d) {
  const section = h("section", { class: "wh-section" });
  const allowlist = Array.isArray(d.allowlist) ? d.allowlist : [];
  const groups = Array.isArray(d.groups) ? d.groups : [];
  const chats = Array.isArray(d.chats) ? d.chats : [];

  section.append(
    h(
      "header",
      { class: "wh-actions", style: "justify-content: space-between;" },
      h(
        "div",
        {},
        h("h3", {}, "Allowlist"),
        h(
          "p",
          { class: "panel-sub" },
          h("span", { class: "wh-count" }, `${allowlist.length} enabled`),
        ),
      ),
    ),
  );

  const searchInput = h("input", {
    type: "search",
    class: "search wh-search",
    "data-search": "webhooks",
    placeholder: "Filter by name or JID...",
    "aria-label": "Filter allowlist",
    value: state.filter.webhooks || "",
    oninput: (e) => {
      state.filter.webhooks = e.target.value;
      render("webhooks");
    },
  });
  section.append(searchInput);

  // Build unified rows from groups + chats, deduped by jid.
  const rowsByJid = new Map();
  for (const g of groups) {
    if (!g?.jid) continue;
    rowsByJid.set(g.jid, {
      jid: g.jid,
      name: g.subject || "",
      kind: "group",
    });
  }
  for (const c of chats) {
    if (!c?.jid) continue;
    if (rowsByJid.has(c.jid)) continue;
    rowsByJid.set(c.jid, {
      jid: c.jid,
      name: c.name || "",
      kind: Number(c.is_group) === 1 ? "group" : "chat",
    });
  }

  const q = (state.filter.webhooks || "").trim().toLowerCase();
  const allSet = new Set(allowlist);
  let rows = Array.from(rowsByJid.values());
  if (q) {
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) || r.jid.toLowerCase().includes(q),
    );
  }
  rows.sort((a, b) => (a.name || a.jid).localeCompare(b.name || b.jid));

  if (!rows.length) {
    section.append(emptyEl("No chats match that filter."));
  } else {
    const tbody = h("tbody");
    for (const r of rows) {
      const checked = allSet.has(r.jid);
      const checkbox = h("input", {
        type: "checkbox",
        checked: checked,
        "aria-label": "Toggle allowlist for " + r.jid,
      });
      checkbox.addEventListener("change", async () => {
        await toggleAllowlist(r.jid, checkbox.checked);
      });
      tbody.append(
        h(
          "tr",
          {},
          h("td", {}, checkbox),
          h("td", {}, r.name || h("span", { class: "mono" }, "(unnamed)")),
          h(
            "td",
            { class: "mono" },
            h(
              "span",
              { class: "jid-cell" },
              h("span", { class: "truncate", title: r.jid }, r.jid),
              copyButton(r.jid),
            ),
          ),
          h(
            "td",
            {},
            r.kind === "group"
              ? h("span", { class: "badge badge-accent" }, "group")
              : h("span", { class: "badge" }, "chat"),
          ),
        ),
      );
    }
    section.append(
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", {}, ""),
              h("th", {}, "Name"),
              h("th", {}, "JID"),
              h("th", {}, "Kind"),
            ),
          ),
          tbody,
        ),
      ),
    );
  }

  // Orphans — allowlist entries not in groups/chats.
  const orphans = allowlist.filter((j) => !rowsByJid.has(j));
  if (orphans.length) {
    section.append(h("h4", { style: "margin-top:8px;" }, "Other"));
    const tbody = h("tbody");
    for (const jid of orphans) {
      const removeBtn = h(
        "button",
        {
          class: "btn",
          onclick: async () => {
            await toggleAllowlist(jid, false);
          },
        },
        "Remove",
      );
      tbody.append(
        h(
          "tr",
          {},
          h(
            "td",
            { class: "mono" },
            h(
              "span",
              { class: "jid-cell" },
              h("span", { class: "truncate", title: jid }, jid),
              copyButton(jid),
            ),
          ),
          h("td", { style: "text-align:right;" }, removeBtn),
        ),
      );
    }
    section.append(
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h(
            "thead",
            {},
            h("tr", {}, h("th", {}, "JID"), h("th", {}, "")),
          ),
          tbody,
        ),
      ),
    );
  }

  return section;
}

async function toggleAllowlist(jid, enabled) {
  const method = enabled ? "POST" : "DELETE";
  const path = "/api/webhook/allowlist/" + encodeURIComponent(jid);
  try {
    const updated = await apiSend(method, path);
    if (Array.isArray(updated) && state.data.webhooks) {
      state.data.webhooks.allowlist = updated;
    }
    showToast(enabled ? "Added to allowlist" : "Removed from allowlist");
  } catch (err) {
    showToast(webhookErrorText(err, "Update failed"));
  } finally {
    render("webhooks");
  }
}

function renderWebhookTemplates(d) {
  const section = h("section", { class: "wh-section" });
  const templates = d.templates || {};
  const tpl = state.webhooks;

  const headerActions = h("div", { class: "wh-actions" });
  const newBtn = h(
    "button",
    {
      class: "btn",
      onclick: () => {
        tpl.editingTemplate = {
          id: "",
          template: "",
          description: "",
          isNew: true,
        };
        render("webhooks");
      },
    },
    "New template",
  );
  headerActions.append(newBtn);

  section.append(
    h(
      "header",
      { class: "wh-actions", style: "justify-content: space-between;" },
      h(
        "div",
        {},
        h("h3", {}, "Templates"),
        h(
          "p",
          { class: "panel-sub" },
          `${Object.keys(templates).length} saved`,
        ),
      ),
      headerActions,
    ),
  );

  if (tpl.editingTemplate) {
    section.append(renderTemplateEditor(tpl.editingTemplate));
  }

  const ids = Object.keys(templates).sort();
  if (!ids.length && !tpl.editingTemplate) {
    section.append(emptyEl("No templates yet. Create one to get started."));
    return section;
  }

  const list = h("div", { class: "wh-templates" });
  for (const id of ids) {
    const t = templates[id] || {};
    list.append(renderTemplateCard(id, t));
  }
  section.append(list);
  return section;
}

function renderTemplateEditor(edit) {
  const card = h("div", { class: "wh-template" });
  const validId = (s) => /^[a-z0-9_-]+$/i.test(String(s || ""));
  const idInput = h("input", {
    type: "text",
    placeholder: "slug id (a-z 0-9 _ -)",
    value: edit.id || "",
    disabled: !edit.isNew,
    oninput: (e) => {
      edit.id = e.target.value;
      saveBtn.disabled = !validId(edit.id);
    },
  });
  const descInput = h("input", {
    type: "text",
    placeholder: "Short description (optional)",
    value: edit.description || "",
    oninput: (e) => {
      edit.description = e.target.value;
    },
  });
  const bodyInput = h(
    "textarea",
    {
      placeholder: "Template body. Use {{variable}} placeholders.",
      oninput: (e) => {
        edit.template = e.target.value;
      },
    },
    edit.template || "",
  );

  const saveBtn = h(
    "button",
    {
      class: "btn",
      disabled: !validId(edit.id),
      onclick: async () => {
        if (!validId(edit.id)) {
          showToast("Invalid ID (use a-z, 0-9, _ and -)");
          return;
        }
        const bodyTxt = (edit.template || "").trim();
        if (!bodyTxt) {
          showToast("Template body cannot be empty");
          return;
        }
        saveBtn.disabled = true;
        try {
          const res = await apiSend(
            "PUT",
            "/api/webhook/templates/" + encodeURIComponent(edit.id),
            { template: bodyTxt, description: edit.description || "" },
          );
          if (state.data.webhooks && res && res.id) {
            state.data.webhooks.templates[res.id] = res;
          }
          state.webhooks.editingTemplate = null;
          showToast("Template saved");
        } catch (err) {
          showToast(webhookErrorText(err, "Save failed"));
        } finally {
          saveBtn.disabled = false;
          render("webhooks");
        }
      },
    },
    "Save",
  );
  const cancelBtn = h(
    "button",
    {
      class: "btn btn-ghost",
      onclick: () => {
        state.webhooks.editingTemplate = null;
        render("webhooks");
      },
    },
    "Cancel",
  );

  const form = h(
    "div",
    { class: "wh-form" },
    h("label", {}, "ID", idInput),
    h("label", {}, "Description", descInput),
    h("label", {}, "Template", bodyInput),
    h("div", { class: "wh-actions" }, cancelBtn, saveBtn),
  );
  card.append(
    h(
      "header",
      {},
      h(
        "span",
        { class: "id" },
        edit.isNew ? "New template" : `Edit: ${edit.id}`,
      ),
    ),
    form,
  );
  return card;
}

function renderTemplateCard(id, t) {
  const card = h("div", { class: "wh-template" });
  const actions = h(
    "div",
    { class: "wh-actions" },
    h(
      "button",
      {
        class: "btn",
        onclick: () => {
          state.webhooks.editingTemplate = {
            id: id,
            template: String(t.template || ""),
            description: String(t.description || ""),
            isNew: false,
          };
          render("webhooks");
        },
      },
      "Edit",
    ),
    h(
      "button",
      {
        class: "btn",
        onclick: async () => {
          if (!window.confirm(`Delete template "${id}"?`)) return;
          try {
            await apiSend(
              "DELETE",
              "/api/webhook/templates/" + encodeURIComponent(id),
            );
            if (state.data.webhooks) {
              delete state.data.webhooks.templates[id];
            }
            showToast("Template deleted");
          } catch (err) {
            showToast(webhookErrorText(err, "Delete failed"));
          } finally {
            render("webhooks");
          }
        },
      },
      "Delete",
    ),
  );

  const header = h(
    "header",
    {},
    h(
      "div",
      {},
      h("span", { class: "id" }, id),
      t.description
        ? h("span", { class: "desc" }, " — " + String(t.description))
        : null,
    ),
    actions,
  );
  card.append(header);

  const pre = h("pre");
  pre.textContent = String(t.template || "");
  card.append(pre);

  const vars = extractVars(t.template || "");
  const varsEl = h("div", { class: "wh-vars" });
  varsEl.append(h("span", {}, "Variables: "));
  if (!vars.length) {
    varsEl.append(h("span", { class: "mono" }, "(none)"));
  } else {
    for (const v of vars) {
      varsEl.append(h("span", { class: "badge mono" }, "{{" + v + "}}"));
    }
  }
  card.append(varsEl);

  return card;
}

// ---------- wiring ----------

function wire() {
  // Tabs
  $$(".tab").forEach((t) => {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  });

  // Search
  $$(".search").forEach((input) => {
    const which = input.dataset.search;
    input.addEventListener("input", () => {
      state.filter[which] = input.value;
      render(which);
    });
  });

  // Refresh buttons
  $$("[data-refresh]").forEach((b) => {
    b.addEventListener("click", () => {
      refreshChannels();
      loadTab(b.dataset.refresh);
    });
  });

  // Drawer close
  $$("[data-close-drawer]").forEach((el) => el.addEventListener("click", closeDrawer));

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const typingInField =
      e.target instanceof HTMLElement &&
      (e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.isContentEditable);

    if (e.key === "Escape") {
      closeDrawer();
      return;
    }
    if (typingInField) return;
    if (e.key === "/") {
      e.preventDefault();
      const input = $(`.search[data-search="${state.currentTab}"]`);
      input?.focus();
      input?.select();
      return;
    }
    const idx = Number(e.key);
    if (Number.isInteger(idx) && idx >= 1 && idx <= TABS.length) {
      switchTab(TABS[idx - 1]);
    }
  });
}

// ---------- bootstrap ----------

async function main() {
  wire();
  refreshChannels();
  switchTab("groups");
}

main().catch((err) => {
  console.error(err);
  showToast("Failed to initialise admin UI");
});
