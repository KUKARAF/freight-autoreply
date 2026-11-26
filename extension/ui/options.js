import { normalizeBaseUrl } from "../lib/backend.js";

const $ = (id) => document.getElementById(id);
const call = (type, extra) => browser.runtime.sendMessage({ from: "ui", type, ...extra });
const fields = () => [...document.querySelectorAll("#form input[id*='.']")];
const status = (text) => ($("status").textContent = text);
const backend = () => ({ baseUrl: $("backend.baseUrl").value.trim(), apiKey: $("backend.apiKey").value.trim() });

async function load() {
  const { settings } = await call("getAll");
  for (const input of fields()) {
    const [group, key] = input.id.split(".");
    if (input.type === "checkbox") input.checked = settings[group][key];
    else input.value = settings[group][key];
  }
}

// Must be the first await in a click handler, while the click still counts as user input.
function requestAccess() {
  const url = new URL(normalizeBaseUrl(backend().baseUrl));
  return browser.permissions.request({
    origins: [`${url.protocol}//${url.hostname}/*`],
    data_collection: ["personalCommunications"],
  });
}

$("check").onclick = async () => {
  try {
    if (!(await requestAccess())) return status("The extension needs that permission to use the server.");
  } catch (e) {
    return status(e.message);
  }
  status("Checking…");
  const r = await call("checkConnection", { backend: backend() });
  if (!r.ok) return status(`Not connected: ${r.error}`);
  status(`Connected as ${r.email}.${r.aiConfigured ? "" : " AI replies are not set up on the server."}`);
};

$("website").onclick = () => {
  try {
    window.open(normalizeBaseUrl(backend().baseUrl), "_blank", "noopener");
  } catch (e) {
    status(e.message);
  }
};

$("form").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    normalizeBaseUrl(backend().baseUrl);
    if (backend().apiKey && !(await requestAccess())) {
      return status("Not saved: the extension needs that permission to use the server.");
    }
  } catch (e) {
    return status(e.message);
  }
  // enabled / autoSend are owned by the popup, so keep their current values.
  const { settings } = await call("getAll");
  const next = structuredClone(settings);
  for (const input of fields()) {
    const [group, key] = input.id.split(".");
    if (input.type === "checkbox") next[group][key] = input.checked;
    else if (input.type === "number") next[group][key] = Number(input.value);
    else next[group][key] = input.value.trim();
  }
  await call("saveSettings", { settings: next });
  status("Saved.");
};

load();
