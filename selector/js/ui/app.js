// app.js — boot + hash router. Loads the registry and the family KBs ONCE,
// then mounts one of three modes into #mode-root; all three are renderings of
// the same solve() contract:
//   #lookup  exact-model lookup — one text field, option tables
//   #full    full-option facet view — every control at once
//   #guided  step-by-step in the registry's ask_priority order, ending in the
//            pre-filled full view
// No hash shows the landing (mode chooser). Mode switching never refetches;
// the guided → full handoff travels in-memory on the shared ctx.

import { loadRegistry } from "../core/registry.js";
import { loadKBs } from "../core/kb.js";
import { el } from "./shared.js";
import { mount as mountFull } from "./modes/full.js";
import { mount as mountLookup } from "./modes/lookup.js";
import { mount as mountGuided } from "./modes/guided.js";

const REGISTRY_URL = "../DB/switching/switching-axes.json";
const FAMILIES_URL = "../DB/switching/families.json";

const MODES = {
  lookup: {
    title: "Model lookup",
    blurb:
      "You know the exact model. Get its uplink, PSU, license, and accessory options — the datasheet summary, without the datasheet.",
    mount: mountLookup,
  },
  full: {
    title: "Full options",
    blurb:
      "Every requirement control at once. Results re-solve on each change; dead choices grey out; each candidate shows its default kit and the open alternatives.",
    mount: mountFull,
  },
  guided: {
    title: "Guided run",
    blurb:
      "Step through the requirements one at a time in a sensible order — skip what you don't care about — and land in the full view with everything filled in.",
    mount: mountGuided,
  },
};

const ctx = { registry: null, kb: null, handoff: null };

async function init() {
  const status = document.getElementById("status");
  try {
    const familiesRes = await fetch(FAMILIES_URL);
    if (!familiesRes.ok)
      throw new Error(`families fetch failed: ${familiesRes.status} ${FAMILIES_URL}`);
    const families = await familiesRes.json();
    const kbUrls = families.map((f) => `../DB/switching/${f.dir}/${f.kbFile}`);
    [ctx.registry, ctx.kb] = await Promise.all([loadRegistry(REGISTRY_URL), loadKBs(kbUrls)]);
    status.textContent = `Loaded ${ctx.kb.models.length} models · registry v${ctx.registry.registry_version}`;
    buildTabs();
    window.addEventListener("hashchange", route);
    route();
  } catch (err) {
    status.textContent = `Failed to load data: ${err.message}`;
    status.classList.add("error");
  }
}

function currentMode() {
  const name = location.hash.replace(/^#/, "");
  return name in MODES ? name : null;
}

function buildTabs() {
  const nav = document.getElementById("mode-tabs");
  nav.innerHTML = "";
  const home = el("a", "mode-tab home", "⌂");
  home.href = "#";
  home.title = "mode choice";
  nav.appendChild(home);
  for (const [name, mode] of Object.entries(MODES)) {
    const a = el("a", "mode-tab", mode.title);
    a.href = `#${name}`;
    a.dataset.mode = name;
    nav.appendChild(a);
  }
}

function route() {
  const root = document.getElementById("mode-root");
  const mode = currentMode();
  for (const a of document.querySelectorAll("#mode-tabs .mode-tab"))
    a.classList.toggle("active", a.dataset.mode === mode);
  root.className = mode ? `mode-${mode}` : "mode-landing";
  if (!mode) {
    renderLanding(root);
    return;
  }
  MODES[mode].mount(root, ctx);
}

function renderLanding(root) {
  root.innerHTML = "";
  const wrap = el("section", "landing");
  wrap.appendChild(el("h2", null, "How do you want to work?"));
  const cards = el("div", "mode-cards");
  for (const [name, mode] of Object.entries(MODES)) {
    const card = el("a", "mode-card");
    card.href = `#${name}`;
    card.appendChild(el("h3", null, mode.title));
    card.appendChild(el("p", null, mode.blurb));
    cards.appendChild(card);
  }
  wrap.appendChild(cards);
  root.appendChild(wrap);
}

init();
