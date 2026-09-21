const PALETTE = ["#3B82F6", "#22C55E", "#F97316", "#A855F7", "#06B6D4", "#EC4899", "#EAB308", "#6366F1"];

const state = {
  always_on_top: true,
  show_new: false,
  show_notes: false,
  categories: [],
  selectedId: null,
  ready: false,
  analyticsRange: "week",
};

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID().replaceAll("-", "");
  return `id${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

function now() {
  const d = new Date();
  d.setMilliseconds(0);
  return d;
}

function iso(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseIso(text) {
  return new Date(text);
}

function dayBounds(moment) {
  const start = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end];
}

function weekBounds(moment) {
  const start = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return [start, end];
}

function monthBounds(moment) {
  const start = new Date(moment.getFullYear(), moment.getMonth(), 1);
  const end = new Date(moment.getFullYear(), moment.getMonth() + 1, 1);
  return [start, end];
}

function intervals(category, moment) {
  const found = [];
  for (const session of category.sessions || []) {
    const start = parseIso(session.start);
    const end = parseIso(session.end);
    if (end > start) found.push([start, end, false]);
  }
  if (category.running_since) {
    const start = parseIso(category.running_since);
    if (moment > start) found.push([start, moment, true]);
  }
  return found;
}

function secondsBetween(category, rangeStart, rangeEnd, moment) {
  let total = 0;
  for (const [start, end] of intervals(category, moment)) {
    const lo = Math.max(start.getTime(), rangeStart.getTime());
    const hi = Math.min(end.getTime(), rangeEnd.getTime());
    if (hi > lo) total += (hi - lo) / 1000;
  }
  return Math.floor(total);
}

function formatDuration(seconds, withSeconds = false) {
  seconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (withSeconds) {
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
    if (minutes) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
    return `${secs}s`;
  }
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m`;
  return seconds === 0 ? "0m" : `${secs}s`;
}

function formatHours(seconds) {
  const hours = seconds / 3600;
  if (hours >= 10) return `${Math.round(hours)}h`;
  if (hours >= 1) return `${hours.toFixed(1).replace(/\.0$/, "")}h`;
  return formatDuration(seconds);
}

function placeMinutes(category, minutes, moment) {
  const duration = minutes * 60 * 1000;
  let end = moment.getTime();
  for (let i = 0; i < 200; i += 1) {
    const start = end - duration;
    const blocking = intervals(category, moment)
      .filter(([s, e]) => start < e.getTime() && s.getTime() < end)
      .map(([s]) => s.getTime());
    if (!blocking.length) return [new Date(start), new Date(end)];
    const earlier = Math.min(...blocking);
    end = earlier >= end ? end - 1000 : earlier;
  }
  return [new Date(end - duration), new Date(end)];
}

function removeMinutes(category, minutes, moment) {
  let remaining = Math.max(0, Math.floor(minutes)) * 60;
  const sessions = [...(category.sessions || [])].sort((a, b) => a.start.localeCompare(b.start));

  while (remaining > 0 && sessions.length) {
    const last = sessions[sessions.length - 1];
    const startMs = parseIso(last.start).getTime();
    const endMs = parseIso(last.end).getTime();
    const dur = Math.max(0, (endMs - startMs) / 1000);
    if (dur <= remaining + 0.001) {
      remaining -= dur;
      sessions.pop();
    } else {
      last.end = iso(new Date(endMs - remaining * 1000));
      remaining = 0;
    }
  }

  if (remaining > 0 && category.running_since) {
    const startMs = parseIso(category.running_since).getTime();
    const elapsed = Math.max(0, (moment.getTime() - startMs) / 1000);
    if (elapsed <= remaining + 0.001) {
      category.running_since = iso(moment);
    } else {
      category.running_since = iso(new Date(startMs + remaining * 1000));
    }
  }

  category.sessions = sessions;
}

function iconFor(name) {
  const words = name.toLowerCase().replaceAll("-", " ").split(/\s+/);
  const joined = words.join(" ");
  if (words.includes("break") || joined.includes("break")) return "☕";
  if (joined.includes("meeting")) return "👥";
  if (joined.includes("timesheet") || joined.includes("task")) return "📄";
  if (joined.includes("creative")) return "✎";
  if (words.includes("ai")) return "✦";
  if (joined.includes("mentor")) return "◎";
  return "◆";
}

function findCategory(id) {
  return state.categories.find((c) => c.id === id) || null;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function openSheet(id) {
  document.getElementById(id).classList.add("open");
}

function closeSheet(id) {
  document.getElementById(id).classList.remove("open");
}

async function persist() {
  const payload = {
    always_on_top: state.always_on_top,
    show_new: state.show_new,
    show_notes: state.show_notes,
    categories: state.categories,
  };
  try {
    await fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    /* keep UI responsive even if a save briefly fails */
  }
}

function persistSoon() {
  clearTimeout(state.persistTimer);
  state.persistTimer = setTimeout(() => {
    persist();
  }, 180);
}

function playSvg(running) {
  if (running) {
    return `<svg viewBox="0 0 14 14"><rect x="3" y="2" width="3" height="10" rx="0.5"/><rect x="8" y="2" width="3" height="10" rx="0.5"/></svg>`;
  }
  return `<svg viewBox="0 0 14 14"><path d="M3.5 2.2v9.6L12 7z"/></svg>`;
}

function rangeBounds(range, moment) {
  return range === "month" ? monthBounds(moment) : weekBounds(moment);
}

function analyticsRows(range) {
  const moment = now();
  const [start, end] = rangeBounds(range, moment);
  return state.categories
    .map((category) => ({
      id: category.id,
      name: category.name,
      color: category.color || PALETTE[0],
      seconds: secondsBetween(category, start, end, moment),
    }))
    .filter((row) => row.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
}

function renderList() {
  const root = document.getElementById("list");
  if (!state.categories.length) {
    root.innerHTML = `<div class="empty">Add a category to begin tracking today.</div>`;
    return;
  }
  const moment = now();
  const [dayStart, dayEnd] = dayBounds(moment);
  root.innerHTML = state.categories.map((category) => {
    const today = secondsBetween(category, dayStart, dayEnd, moment);
    const running = Boolean(category.running_since);
    const selected = category.id === state.selectedId;
    return `
      <div class="card ${selected ? "selected" : ""} ${running ? "running" : ""}" style="--accent:${category.color}" data-id="${category.id}">
        <div class="icon-bubble">${iconFor(category.name)}</div>
        <div class="copy">
          <div class="title">${escapeHtml(category.name)}</div>
          <div class="meta">${formatDuration(today, running)} today</div>
        </div>
        <div class="card-actions">
          <button class="play ${running ? "stop" : ""}" data-action="toggle" aria-label="${running ? "Stop" : "Play"}">${playSvg(running)}</button>
          <button class="icon-btn" data-action="minutes" title="Adjust minutes">✎</button>
        </div>
      </div>
    `;
  }).join("");
}

function refreshLiveTimes() {
  const moment = now();
  const [dayStart, dayEnd] = dayBounds(moment);
  const [weekStart, weekEnd] = weekBounds(moment);
  let todayTotal = 0;
  let weekTotal = 0;
  for (const category of state.categories) {
    const today = secondsBetween(category, dayStart, dayEnd, moment);
    const week = secondsBetween(category, weekStart, weekEnd, moment);
    todayTotal += today;
    weekTotal += week;
    const card = document.querySelector(`.card[data-id="${category.id}"]`);
    if (!card) continue;
    const running = Boolean(category.running_since);
    const meta = card.querySelector(".meta");
    if (meta) meta.textContent = `${formatDuration(today, running)} today`;
    card.classList.toggle("running", running);
    const play = card.querySelector(".play");
    if (play) {
      const shouldStop = running;
      if (play.classList.contains("stop") !== shouldStop) {
        play.classList.toggle("stop", shouldStop);
        play.setAttribute("aria-label", shouldStop ? "Stop" : "Play");
        play.innerHTML = playSvg(shouldStop);
      }
    }
  }
  const todayEl = document.getElementById("todayValue");
  const weekEl = document.getElementById("weekValue");
  if (todayEl) todayEl.textContent = formatDuration(todayTotal, true);
  if (weekEl) weekEl.textContent = `This week ${formatDuration(weekTotal)}`;
}

function updateHero() {
  refreshLiveTimes();
  const dateLabel = document.getElementById("dateLabel");
  if (dateLabel) {
    dateLabel.textContent = now().toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }
}

function updateSessionLine() {
  const category = findCategory(state.selectedId);
  const session = document.getElementById("sessionLine");
  if (!session) return;
  if (!category) {
    session.textContent = "";
    return;
  }
  const moment = now();
  const [dayStart, dayEnd] = dayBounds(moment);
  const parts = [];
  for (const [start, end, open] of intervals(category, moment)) {
    if (end <= dayStart || start >= dayEnd) continue;
    const lo = new Date(Math.max(start.getTime(), dayStart.getTime()));
    const hi = new Date(Math.min(end.getTime(), dayEnd.getTime()));
    const stamp = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    parts.push(`${stamp(lo)}–${open ? "now" : stamp(hi)}`);
  }
  session.textContent = parts.length ? `Today: ${parts.slice(-8).join(", ")}` : "Today: no time yet";
}

function renderAnalytics() {
  const rows = analyticsRows(state.analyticsRange);
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);
  const isMonth = state.analyticsRange === "month";
  document.getElementById("analyticsTitle").textContent = isMonth ? "Monthly analytics" : "Weekly analytics";
  document.getElementById("analyticsSubtitle").textContent = isMonth
    ? "Hours by category this month"
    : "Hours by category this week";
  document.getElementById("analyticsTotal").textContent = formatHours(total);
  document.querySelectorAll("[data-analytics-range]").forEach((button) => {
    button.classList.toggle("active", button.dataset.analyticsRange === state.analyticsRange);
  });
  const root = document.getElementById("analyticsBars");
  if (!rows.length) {
    root.innerHTML = `<div class="empty">No tracked time in this range yet.</div>`;
    return;
  }
  root.innerHTML = rows.map((row) => {
    const pct = total ? Math.max(4, Math.round((row.seconds / total) * 100)) : 0;
    return `
      <div class="analytics-row" data-id="${row.id}">
        <div class="analytics-row-top">
          <strong>${escapeHtml(row.name)}</strong>
          <span>${formatHours(row.seconds)} · ${Math.round((row.seconds / total) * 100)}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${row.color}"></div></div>
      </div>
    `;
  }).join("");
  requestAnimationFrame(() => {
    root.querySelectorAll(".bar-fill").forEach((bar) => {
      bar.style.width = bar.style.width;
    });
  });
}

function updatePanels() {
  document.getElementById("newPanel").classList.toggle("open", state.show_new);
  document.getElementById("notesPanel").classList.toggle("open", state.show_notes);
  document.getElementById("newToggleLabel").textContent = state.show_new ? "−   New category" : "+   New category";
  const category = findCategory(state.selectedId);
  document.getElementById("notesToggleLabel").textContent = category ? `Notes — ${category.name}` : "Notes";
  document.getElementById("pinToggle").checked = state.always_on_top;
}

function updateNotes() {
  const category = findCategory(state.selectedId);
  const notes = document.getElementById("notes");
  if (!category) {
    notes.value = "";
    notes.disabled = true;
    updateSessionLine();
    return;
  }
  notes.disabled = false;
  if (document.activeElement !== notes) notes.value = category.notes || "";
  updateSessionLine();
}

function render() {
  renderList();
  updateHero();
  updatePanels();
  updateNotes();
}

function stopCategory(category, moment) {
  const startText = category.running_since;
  category.running_since = null;
  if (!startText) return;
  const start = parseIso(startText);
  if (moment > start) {
    category.sessions.push({ start: startText, end: iso(moment) });
  }
}

function toggle(id) {
  const category = findCategory(id);
  if (!category) return;
  const moment = now();
  if (category.running_since) stopCategory(category, moment);
  else {
    for (const other of state.categories) {
      if (other.running_since) stopCategory(other, moment);
    }
    category.running_since = iso(moment);
  }
  state.selectedId = id;
  persistSoon();
  render();
}

function select(id) {
  if (state.selectedId === id) return;
  saveNotes();
  state.selectedId = id;
  persistSoon();
  render();
}

function addCategory() {
  const input = document.getElementById("newName");
  const name = input.value.trim();
  if (!name) {
    state.show_new = true;
    updatePanels();
    input.focus();
    return;
  }
  const category = {
    id: uid(),
    name: name.slice(0, 80),
    color: PALETTE[state.categories.length % PALETTE.length],
    notes: "",
    running_since: null,
    sessions: [],
  };
  state.categories.push(category);
  state.selectedId = category.id;
  state.show_new = false;
  input.value = "";
  persistSoon();
  render();
}

function saveNotes() {
  const category = findCategory(state.selectedId);
  if (!category) return;
  const value = document.getElementById("notes").value;
  if (value === (category.notes || "")) return;
  category.notes = value;
  persistSoon();
}

function openMinutesModal(id) {
  state.pendingMinutesId = id;
  select(id);
  const category = findCategory(id);
  document.getElementById("minutesCopy").textContent = `Adjust ${category?.name || "category"} · +15 adds, -10 removes`;
  document.getElementById("minutesInput").value = "15";
  openSheet("minutesModal");
  document.getElementById("minutesInput").focus();
  document.getElementById("minutesInput").select();
}

function confirmMinutes() {
  const category = findCategory(state.pendingMinutesId);
  const raw = document.getElementById("minutesInput").value.trim();
  const minutes = Number.parseInt(raw, 10);
  closeSheet("minutesModal");
  if (!category || !Number.isFinite(minutes) || minutes === 0) return;
  const moment = now();
  if (minutes > 0) {
    const [start, end] = placeMinutes(category, Math.min(minutes, 24 * 60), moment);
    category.sessions.push({ start: iso(start), end: iso(end) });
    category.sessions.sort((a, b) => a.start.localeCompare(b.start));
  } else {
    removeMinutes(category, Math.min(Math.abs(minutes), 24 * 60), moment);
  }
  persistSoon();
  render();
}

function openRenameModal() {
  const category = findCategory(state.selectedId);
  if (!category) return;
  document.getElementById("renameInput").value = category.name;
  openSheet("renameModal");
  document.getElementById("renameInput").focus();
  document.getElementById("renameInput").select();
}

function confirmRename() {
  const category = findCategory(state.selectedId);
  const cleaned = document.getElementById("renameInput").value.trim();
  closeSheet("renameModal");
  if (!category || !cleaned) return;
  category.name = cleaned.slice(0, 80);
  persistSoon();
  render();
}

function openDeleteModal() {
  const category = findCategory(state.selectedId);
  if (!category) return;
  document.getElementById("deleteCopy").textContent = `Delete “${category.name}” and its tracked time?`;
  openSheet("deleteModal");
}

function confirmDelete() {
  const category = findCategory(state.selectedId);
  closeSheet("deleteModal");
  if (!category) return;
  state.categories = state.categories.filter((item) => item.id !== category.id);
  state.selectedId = state.categories[0]?.id || null;
  persistSoon();
  render();
}

function setAnalyticsRange(range) {
  state.analyticsRange = range === "month" ? "month" : "week";
  if (document.getElementById("analyticsSheet").classList.contains("open")) renderAnalytics();
}

function openAnalytics() {
  renderAnalytics();
  openSheet("analyticsSheet");
}

function setOnTop(enabled) {
  state.always_on_top = Boolean(enabled);
  document.getElementById("pinToggle").checked = state.always_on_top;
  // HTTP path only — pywebview bridge + native handle was freezing the window.
  fetch("/api/on-top", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: state.always_on_top }),
  }).catch(() => {});
}

function wire() {
  if (state.wired) return;
  state.wired = true;

  document.getElementById("list").addEventListener("click", (event) => {
    const card = event.target.closest(".card");
    if (!card) return;
    const id = card.dataset.id;
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "toggle") toggle(id);
    else if (action === "minutes") openMinutesModal(id);
    else select(id);
  });

  document.getElementById("newToggle").addEventListener("click", () => {
    state.show_new = !state.show_new;
    persistSoon();
    updatePanels();
    if (state.show_new) document.getElementById("newName").focus();
  });
  document.getElementById("notesToggle").addEventListener("click", () => {
    saveNotes();
    state.show_notes = !state.show_notes;
    persistSoon();
    updatePanels();
  });
  document.getElementById("addBtn").addEventListener("click", addCategory);
  document.getElementById("newName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addCategory();
  });
  document.getElementById("notes").addEventListener("input", () => {
    clearTimeout(state.noteTimer);
    state.noteTimer = setTimeout(saveNotes, 400);
  });
  document.getElementById("notes").addEventListener("blur", saveNotes);
  document.getElementById("stampBtn").addEventListener("click", () => {
    const notes = document.getElementById("notes");
    if (notes.disabled) return;
    const stamp = `${String(now().getHours()).padStart(2, "0")}:${String(now().getMinutes()).padStart(2, "0")} — `;
    notes.value = stamp + notes.value;
    notes.focus();
    saveNotes();
  });
  document.getElementById("renameBtn").addEventListener("click", openRenameModal);
  document.getElementById("deleteBtn").addEventListener("click", openDeleteModal);

  document.getElementById("analyticsBtn").addEventListener("click", openAnalytics);
  document.getElementById("analyticsClose").addEventListener("click", () => closeSheet("analyticsSheet"));
  document.querySelectorAll("[data-analytics-range]").forEach((button) => {
    button.addEventListener("click", () => {
      setAnalyticsRange(button.dataset.analyticsRange);
      renderAnalytics();
    });
  });
  document.getElementById("analyticsBars").addEventListener("click", (event) => {
    const row = event.target.closest(".analytics-row");
    if (!row) return;
    select(row.dataset.id);
    closeSheet("analyticsSheet");
  });

  document.getElementById("settingsBtn").addEventListener("click", () => openSheet("settingsSheet"));
  document.getElementById("settingsClose").addEventListener("click", () => closeSheet("settingsSheet"));
  document.getElementById("pinToggle").addEventListener("change", (event) => setOnTop(event.target.checked));

  document.getElementById("minutesCancel").addEventListener("click", () => closeSheet("minutesModal"));
  document.getElementById("minutesConfirm").addEventListener("click", confirmMinutes);
  document.getElementById("minutesInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") confirmMinutes();
  });
  document.getElementById("renameCancel").addEventListener("click", () => closeSheet("renameModal"));
  document.getElementById("renameConfirm").addEventListener("click", confirmRename);
  document.getElementById("renameInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") confirmRename();
  });
  document.getElementById("deleteCancel").addEventListener("click", () => closeSheet("deleteModal"));
  document.getElementById("deleteConfirm").addEventListener("click", confirmDelete);

  document.querySelectorAll(".sheet").forEach((sheet) => {
    sheet.addEventListener("click", (event) => {
      if (event.target === sheet) sheet.classList.remove("open");
    });
  });
}

async function boot() {
  if (state.ready) return;
  const data = await fetch("/api/data").then((response) => response.json());
  state.always_on_top = data?.always_on_top !== false;
  state.show_new = Boolean(data?.show_new);
  state.show_notes = Boolean(data?.show_notes);
  state.categories = Array.isArray(data?.categories) ? data.categories : [];
  for (const category of state.categories) {
    category.notes = typeof category.notes === "string" ? category.notes : "";
    category.sessions = Array.isArray(category.sessions) ? category.sessions : [];
    category.running_since = category.running_since || null;
    category.color = category.color || PALETTE[0];
  }
  state.selectedId = state.categories[0]?.id || null;
  state.ready = true;
  wire();
  render();
  setInterval(() => {
    if (!state.ready) return;
    refreshLiveTimes();
    if (state.show_notes) updateSessionLine();
  }, 1000);
}

boot().catch((err) => {
  document.getElementById("list").innerHTML = `<div class="empty">Could not load times.<br>${escapeHtml(String(err))}</div>`;
});
