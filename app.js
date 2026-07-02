(() => {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  const BOARDS_KEY = "tasktoss_boards_v1";
  const ACTIVE_BOARD_KEY = "tasktoss_active_board_v1";
  const TASK_PREFIX = "tasktoss_task_";
  const STREAK_KEY = "tasktoss_streak_v1";
  const STATS_KEY = "tasktoss_stats_v1";
  const indexKey = (boardId) => "tasktoss_index_" + boardId;

  const FOCUS_DURATIONS = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };

  const TAG_PALETTE = ["#FF6B35", "#2F9E44", "#3B82F6", "#A855F7", "#D97706", "#DB2777", "#0EA5A0"];
  const BOARD_PALETTE = ["#FF6B35", "#2F9E44", "#3B82F6", "#A855F7", "#D97706"];

  function hashColor(str, palette) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  // ---------- Telegram bootstrap ----------
  if (tg) {
    tg.ready();
    tg.expand();
    applyTheme();
    tg.onEvent("themeChanged", applyTheme);
    document.getElementById("sync-note").textContent = "synced to your Telegram account";
  }

  function applyTheme() {
    if (!tg || !tg.themeParams) return;
    const p = tg.themeParams;
    const root = document.documentElement.style;
    if (p.bg_color) root.setProperty("--paper", p.bg_color);
    if (p.text_color) root.setProperty("--ink", p.text_color);
    if (p.hint_color) root.setProperty("--slate", p.hint_color);
    if (p.secondary_bg_color) root.setProperty("--card", p.secondary_bg_color);
    if (p.button_color) root.setProperty("--signal", p.button_color);
    if (p.button_text_color) root.setProperty("--signal-ink", p.button_text_color);
  }

  // ---------- Storage layer ----------
  // One key per task (tasktoss_task_<id>) to stay well under CloudStorage's
  // 4096-char-per-value cap. One index key per board (ordered id list).
  // Boards themselves are a tiny separate key.
  const store = {
    getMulti(keys) {
      return new Promise((resolve) => {
        if (!keys.length) return resolve({});
        if (tg && tg.CloudStorage) {
          tg.CloudStorage.getItems(keys, (err, values) => resolve(err ? {} : values));
        } else {
          const out = {};
          for (const k of keys) out[k] = localStorage.getItem(k) || "";
          resolve(out);
        }
      });
    },
    get(key) {
      return new Promise((resolve) => {
        if (tg && tg.CloudStorage) {
          tg.CloudStorage.getItem(key, (err, value) => resolve(err ? "" : value));
        } else {
          resolve(localStorage.getItem(key) || "");
        }
      });
    },
    set(key, value) {
      if (tg && tg.CloudStorage) {
        tg.CloudStorage.setItem(key, value, (err) => { if (err) console.error("save failed", key, err); });
      } else {
        localStorage.setItem(key, value);
      }
    },
    remove(key) {
      if (tg && tg.CloudStorage) tg.CloudStorage.removeItem(key);
      else localStorage.removeItem(key);
    }
  };

  function saveTask(task) { store.set(TASK_PREFIX + task.id, JSON.stringify(task)); }
  function deleteTaskFromStore(id) { store.remove(TASK_PREFIX + id); }
  function saveIndex(boardId, ids) { store.set(indexKey(boardId), JSON.stringify(ids)); }
  function saveBoards() { store.set(BOARDS_KEY, JSON.stringify(boards)); }
  function saveStreak() { store.set(STREAK_KEY, JSON.stringify(streak)); }
  function saveStats() { store.set(STATS_KEY, JSON.stringify(stats)); }

  async function loadJSON(key, fallback) {
    const raw = await store.get(key);
    try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  }

  async function loadBoards() {
    const raw = await store.get(BOARDS_KEY);
    let list = [];
    try { list = JSON.parse(raw || "[]"); } catch { list = []; }
    if (!list.length) {
      list = [{ id: "inbox", name: "Inbox" }];
      await store.set(BOARDS_KEY, JSON.stringify(list));
      await store.set(indexKey("inbox"), "[]");
    }
    return list;
  }

  async function loadTasksForBoard(boardId) {
    const raw = await store.get(indexKey(boardId));
    let ids = [];
    try { ids = JSON.parse(raw || "[]"); } catch { ids = []; }
    if (!ids.length) return [];
    const keys = ids.map((id) => TASK_PREFIX + id);
    const values = await store.getMulti(keys);
    const out = [];
    for (const id of ids) {
      const rawTask = values[TASK_PREFIX + id];
      if (!rawTask) continue;
      try {
        const t = JSON.parse(rawTask);
        if (!t.status) t.status = t.done ? "done" : "todo"; // legacy shape safety
        if (!t.tags) t.tags = [];
        out.push(t);
      } catch { /* skip corrupt */ }
    }
    return out;
  }

  async function loadAllTasksAcrossBoards() {
    const results = await Promise.all(boards.map(async (b) => {
      const list = b.id === activeBoardId ? tasks : await loadTasksForBoard(b.id);
      return list.map((t) => Object.assign({}, t, {
        boardId: b.id, boardName: b.name, boardColor: hashColor(b.name, BOARD_PALETTE)
      }));
    }));
    return results.flat();
  }

  // ---------- State ----------
  let boards = [];
  let activeBoardId = null;
  let tasks = [];
  let expanded = new Set();
  let searchQuery = "";
  let activeTag = null;
  let view = "list"; // list | board | archive | focus | profile

  let streak = { count: 0, longest: 0, lastActiveDate: null };
  let stats = { tasksAdded: 0, focusSessionsTotal: 0, focusMinutesTotal: 0 };

  let focusTaskId = null;
  let focusMode = "focus"; // focus | short | long
  let focusRemaining = FOCUS_DURATIONS.focus;
  let focusRunning = false;
  let focusInterval = null;

  const boardTabsEl = document.getElementById("board-tabs");
  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty-state");
  const noResultsEl = document.getElementById("no-results");
  const tagFilterEl = document.getElementById("tag-filter");
  const form = document.getElementById("add-form");
  const titleInput = document.getElementById("title-input");
  const priorityInput = document.getElementById("priority-input");
  const dueInput = document.getElementById("due-input");
  const dueTimeInput = document.getElementById("due-time-input");
  const searchInput = document.getElementById("search-input");
  const toastEl = document.getElementById("toast");
  const viewListBtn = document.getElementById("view-list-btn");
  const viewBoardBtn = document.getElementById("view-board-btn");
  const viewCalendarBtn = document.getElementById("view-calendar-btn");
  const viewArchiveBtn = document.getElementById("view-archive-btn");
  const viewFocusBtn = document.getElementById("view-focus-btn");
  const viewProfileBtn = document.getElementById("view-profile-btn");
  const streakBadgeEl = document.getElementById("streak-badge");
  const focusStatusBadgeEl = document.getElementById("focus-status-badge");

  let calendarWeekStart = startOfWeek(new Date());
  let calendarMonthCursor = startOfMonth(new Date());
  let calendarMode = "week"; // week | month
  let calendarHiddenBoards = new Set(); // board ids toggled off in the calendar legend

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function formatTime(totalSeconds) {
    const s = Math.max(0, totalSeconds);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  }

  function startOfWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  }
  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }
  function startOfMonth(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    return d;
  }
  function addMonths(date, n) {
    const d = new Date(date);
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    return d;
  }
  function monthGridDays(monthStart) {
    const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
    const gridStart = startOfWeek(monthStart);
    const gridEnd = addDays(startOfWeek(monthEnd), 6);
    const days = [];
    for (let d = new Date(gridStart); d <= gridEnd; d = addDays(d, 1)) days.push(new Date(d));
    return days;
  }
  function formatMonthLabel(monthStart) {
    return monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  function toDateKey(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function formatWeekRange(start) {
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const opts = { month: "short", day: "numeric" };
    const startStr = start.toLocaleDateString(undefined, sameMonth ? { day: "numeric" } : opts);
    const endStr = end.toLocaleDateString(undefined, opts);
    return sameMonth
      ? `${start.toLocaleDateString(undefined, { month: "short" })} ${startStr} – ${endStr}`
      : `${startStr} – ${endStr}`;
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  function formatDue(due) {
    if (!due) return null;
    const d = new Date(due + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatTimeOfDay(hhmm) {
    const [hh, mm] = hhmm.split(":").map(Number);
    const t = new Date();
    t.setHours(hh, mm, 0, 0);
    return t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function formatDueFull(task) {
    if (!task.due) return null;
    let str = formatDue(task.due);
    if (task.dueTime) {
      const [hh, mm] = task.dueTime.split(":").map(Number);
      const t = new Date(task.due + "T00:00:00");
      t.setHours(hh, mm);
      str += " " + t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    return str;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // ---------- Streaks ----------
  // "Activity" = completing a task or finishing a focus session on a given day.
  // Consecutive calendar days of activity build the streak; a missed day resets it.
  function recordActivity() {
    const today = toDateKey(new Date());
    if (streak.lastActiveDate === today) return; // already counted today
    const yesterday = toDateKey(addDays(new Date(), -1));
    streak.count = streak.lastActiveDate === yesterday ? streak.count + 1 : 1;
    streak.lastActiveDate = today;
    streak.longest = Math.max(streak.longest || 0, streak.count);
    saveStreak();
    updateStreakBadge();
  }

  function updateStreakBadge() {
    if (!streak.count) { streakBadgeEl.hidden = true; return; }
    streakBadgeEl.hidden = false;
    streakBadgeEl.textContent = `\uD83D\uDD25 ${streak.count}`;
  }

  // ---------- Board tabs ----------
  function renderBoardTabs() {
    boardTabsEl.innerHTML = "";
    for (const b of boards) {
      const count = b.id === activeBoardId
        ? tasks.filter((t) => t.status !== "done").length
        : null;
      const tab = document.createElement("button");
      tab.className = "board-tab" + (b.id === activeBoardId ? " active" : "");
      tab.style.borderTopColor = hashColor(b.name, BOARD_PALETTE);
      tab.innerHTML = `${escapeHtml(b.name)}${count !== null ? `<span class="count">${count}</span>` : ""}`;
      tab.addEventListener("click", () => switchBoard(b.id));
      boardTabsEl.appendChild(tab);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "board-tab-add";
    addBtn.textContent = "+";
    addBtn.addEventListener("click", promptNewBoard);
    boardTabsEl.appendChild(addBtn);
  }

  function promptNewBoard() {
    const input = document.createElement("input");
    input.className = "board-new-input";
    input.placeholder = "Board name…";
    input.maxLength = 24;
    boardTabsEl.replaceChild(input, boardTabsEl.lastChild);
    input.focus();
    const commit = async () => {
      const name = input.value.trim();
      if (name) await addBoard(name);
      else renderBoardTabs();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") renderBoardTabs(); });
    input.addEventListener("blur", commit);
  }

  async function addBoard(name) {
    const b = { id: uid(), name };
    boards.push(b);
    saveBoards();
    await store.set(indexKey(b.id), "[]");
    await switchBoard(b.id);
  }

  async function switchBoard(id) {
    activeBoardId = id;
    store.set(ACTIVE_BOARD_KEY, id);
    expanded.clear();
    activeTag = null;
    pauseTimer();
    focusTaskId = null;
    tasks = await loadTasksForBoard(id);
    renderBoardTabs();
    renderAll();
  }

  // ---------- Filtering ----------
  function matchesQuery(t, q) {
    if (!q) return true;
    const haystack = [t.title, t.notes || "", ...(t.subtasks || []).map((s) => s.title), ...(t.tags || []).map((x) => x.name)]
      .join(" ").toLowerCase();
    return haystack.includes(q);
  }

  function filteredTasks() {
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter((t) => matchesQuery(t, q) && (!activeTag || (t.tags || []).some((x) => x.name === activeTag)));
  }

  function allTagNames() {
    const map = new Map();
    for (const t of tasks) for (const tag of t.tags || []) map.set(tag.name, tag.color);
    return [...map.entries()];
  }

  function renderTagFilter() {
    const names = allTagNames();
    if (!names.length) { tagFilterEl.hidden = true; return; }
    tagFilterEl.hidden = false;
    tagFilterEl.innerHTML = names.map(([name, color]) => `
      <button class="tag-chip ${activeTag === name ? "active" : ""}" data-tag="${escapeHtml(name)}">
        <span class="dot" style="background:${color}"></span>${escapeHtml(name)}
      </button>
    `).join("");
    tagFilterEl.querySelectorAll(".tag-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const name = chip.dataset.tag;
        activeTag = activeTag === name ? null : name;
        renderAll();
      });
    });
  }

  // ---------- Render dispatch ----------
  function renderAll() {
    viewListBtn.classList.toggle("active", view === "list");
    viewBoardBtn.classList.toggle("active", view === "board");
    viewCalendarBtn.classList.toggle("active", view === "calendar");
    viewArchiveBtn.classList.toggle("active", view === "archive");
    viewFocusBtn.classList.toggle("active", view === "focus");
    viewProfileBtn.classList.toggle("active", view === "profile");

    const chromeFreeView = view === "calendar" || view === "focus" || view === "profile";
    tagFilterEl.hidden = chromeFreeView ? true : tagFilterEl.hidden;
    if (!chromeFreeView) renderTagFilter();

    listEl.className = (view === "board" || chromeFreeView) ? "" : "tickets";
    listEl.innerHTML = "";

    if (view === "list") renderListView();
    else if (view === "board") renderBoardView();
    else if (view === "calendar") renderCalendarView();
    else if (view === "focus") renderFocusView();
    else if (view === "profile") renderProfileView();
    else renderArchiveView();
  }

  function renderListView() {
    const visible = filteredTasks().filter((t) => t.status !== "done");
    emptyEl.hidden = tasks.length > 0;
    noResultsEl.hidden = !(tasks.length > 0 && visible.length === 0);
    for (const task of visible) listEl.appendChild(renderTicket(task, { archived: false }));
  }

  function renderArchiveView() {
    const visible = filteredTasks().filter((t) => t.status === "done");
    emptyEl.hidden = true;
    noResultsEl.hidden = visible.length > 0;
    if (visible.length === 0) noResultsEl.textContent = "No completed tasks torn off yet.";
    else noResultsEl.textContent = "Nothing matches here.";
    for (const task of visible) listEl.appendChild(renderTicket(task, { archived: true }));
  }

  function renderBoardView() {
    emptyEl.hidden = tasks.length > 0;
    noResultsEl.hidden = true;
    const wrap = document.createElement("div");
    wrap.className = "board-columns";
    const cols = [["todo", "To do"], ["doing", "Doing"], ["done", "Done"]];
    const visible = filteredTasks();
    for (const [status, label] of cols) {
      const col = document.createElement("div");
      col.className = "board-col";
      col.dataset.status = status;
      const items = visible.filter((t) => t.status === status);
      col.innerHTML = `<div class="board-col-title"><span>${label}</span><span>${items.length}</span></div>`;
      for (const t of items) col.appendChild(renderKanbanCard(t));
      wrap.appendChild(col);
    }
    listEl.appendChild(wrap);
  }

  function renderCalendarView() {
    const isMonth = calendarMode === "month";
    const days = isMonth ? monthGridDays(calendarMonthCursor) : [...Array(7)].map((_, i) => addDays(calendarWeekStart, i));
    const focusMonth = calendarMonthCursor.getMonth();

    const nav = document.createElement("div");
    nav.className = "cal-nav";
    nav.innerHTML = `
      <button id="cal-prev" aria-label="Previous">‹</button>
      <button id="cal-today">today</button>
      <button id="cal-next" aria-label="Next">›</button>
      <span class="cal-range">${isMonth ? formatMonthLabel(calendarMonthCursor) : formatWeekRange(calendarWeekStart)}</span>
      <div class="cal-mode-switch">
        <button type="button" class="cal-mode-btn ${!isMonth ? "active" : ""}" data-mode="week">week</button>
        <button type="button" class="cal-mode-btn ${isMonth ? "active" : ""}" data-mode="month">month</button>
      </div>
    `;
    listEl.appendChild(nav);
    nav.querySelector("#cal-prev").addEventListener("click", () => {
      if (isMonth) calendarMonthCursor = addMonths(calendarMonthCursor, -1);
      else calendarWeekStart = addDays(calendarWeekStart, -7);
      renderAll();
    });
    nav.querySelector("#cal-next").addEventListener("click", () => {
      if (isMonth) calendarMonthCursor = addMonths(calendarMonthCursor, 1);
      else calendarWeekStart = addDays(calendarWeekStart, 7);
      renderAll();
    });
    nav.querySelector("#cal-today").addEventListener("click", () => {
      calendarWeekStart = startOfWeek(new Date());
      calendarMonthCursor = startOfMonth(new Date());
      renderAll();
    });
    nav.querySelectorAll(".cal-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (calendarMode === btn.dataset.mode) return;
        calendarMode = btn.dataset.mode;
        renderAll();
      });
    });

    // Legend mirrors Notion Calendar's toggleable calendar-source list — here, each board is a "calendar".
    const legend = document.createElement("div");
    legend.className = "cal-legend";
    legend.innerHTML = boards.map((b) => {
      const color = hashColor(b.name, BOARD_PALETTE);
      const hidden = calendarHiddenBoards.has(b.id);
      return `<label class="${hidden ? "dim" : ""}">
        <input type="checkbox" data-board="${b.id}" ${hidden ? "" : "checked"} />
        <span class="dot" style="background:${color}"></span>${escapeHtml(b.name)}
      </label>`;
    }).join("");
    listEl.appendChild(legend);
    legend.querySelectorAll("input").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.board;
        if (cb.checked) calendarHiddenBoards.delete(id); else calendarHiddenBoards.add(id);
        renderAll();
      });
    });

    if (isMonth) {
      const weekHead = document.createElement("div");
      weekHead.className = "cal-week-head";
      const sample = [...Array(7)].map((_, i) => addDays(startOfWeek(new Date()), i));
      weekHead.innerHTML = sample.map((d) => `<span>${d.toLocaleDateString(undefined, { weekday: "short" })}</span>`).join("");
      listEl.appendChild(weekHead);
    }

    const grid = document.createElement("div");
    grid.className = "cal-grid" + (isMonth ? " cal-grid-month" : "");
    const todayKey = toDateKey(new Date());
    const dayEls = {};
    for (const d of days) {
      const key = toDateKey(d);
      const outsideMonth = isMonth && d.getMonth() !== focusMonth;
      const col = document.createElement("div");
      col.className = "cal-day" + (key === todayKey ? " today" : "") + (outsideMonth ? " other-month" : "");
      col.innerHTML = `<div class="cal-day-head">
        <span class="cal-day-name">${d.toLocaleDateString(undefined, { weekday: "short" })}</span>
        <span class="cal-day-num">${d.getDate()}</span>
      </div>`;
      grid.appendChild(col);
      dayEls[key] = col;
    }
    listEl.appendChild(grid);

    const q = searchQuery.trim().toLowerCase();
    loadAllTasksAcrossBoards().then((all) => {
      const filtered = all.filter((t) => t.due && !calendarHiddenBoards.has(t.boardId) && matchesQuery(t, q));
      const byDate = {};
      for (const t of filtered) (byDate[t.due] = byDate[t.due] || []).push(t);

      const maxShown = isMonth ? 3 : Infinity;
      for (const key of Object.keys(dayEls)) {
        const col = dayEls[key];
        const items = (byDate[key] || []).sort((a, b) => (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1));
        if (!items.length) {
          if (!isMonth) {
            const empty = document.createElement("div");
            empty.className = "cal-day-empty";
            empty.textContent = "—";
            col.appendChild(empty);
          }
          continue;
        }
        const shown = items.slice(0, maxShown);
        for (const t of shown) {
          const chip = document.createElement("div");
          chip.className = "cal-chip" + (t.status === "done" ? " done" : "");
          chip.style.borderLeftColor = t.boardColor;
          const timeLabel = t.dueTime ? formatTimeOfDay(t.dueTime) + " · " : "";
          chip.innerHTML = `${escapeHtml(t.title)}<span class="cal-chip-board">${escapeHtml(timeLabel + t.boardName)}</span>`;
          chip.addEventListener("click", async () => {
            if (t.boardId !== activeBoardId) await switchBoard(t.boardId);
            view = "list";
            expanded.add(t.id);
            renderBoardTabs();
            renderAll();
          });
          col.appendChild(chip);
        }
        if (items.length > shown.length) {
          const more = document.createElement("div");
          more.className = "cal-more";
          more.textContent = `+${items.length - shown.length} more`;
          more.addEventListener("click", () => {
            calendarWeekStart = startOfWeek(new Date(key + "T00:00:00"));
            calendarMode = "week";
            renderAll();
          });
          col.appendChild(more);
        }
      }
    });
  }

  // ---------- Focus mode ----------
  function renderFocusView() {
    emptyEl.hidden = true;
    noResultsEl.hidden = true;
    const wrap = document.createElement("div");
    wrap.className = "focus-view";

    const activeTask = tasks.find((t) => t.id === focusTaskId && t.status !== "done");
    if (!activeTask) {
      focusTaskId = null;
      const pending = tasks.filter((t) => t.status !== "done");
      wrap.innerHTML = `
        <p class="focus-intro">Pick a task to focus on — a timer keeps you on it, Pomodoro-style.</p>
        <div class="focus-picker">
          ${pending.length
            ? pending.map((t) => `<button type="button" class="focus-pick-btn" data-id="${t.id}">${escapeHtml(t.title)}</button>`).join("")
            : `<p class="empty">No open tasks on this board — add one first.</p>`}
        </div>
      `;
      listEl.appendChild(wrap);
      wrap.querySelectorAll(".focus-pick-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          pauseTimer();
          focusTaskId = btn.dataset.id;
          focusMode = "focus";
          focusRemaining = FOCUS_DURATIONS.focus;
          renderAll();
        });
      });
      return;
    }

    wrap.innerHTML = `
      <div class="focus-task-title">${escapeHtml(activeTask.title)}</div>
      <div class="focus-mode-tabs">
        <button type="button" class="focus-mode-btn ${focusMode === "focus" ? "active" : ""}" data-mode="focus">focus 25</button>
        <button type="button" class="focus-mode-btn ${focusMode === "short" ? "active" : ""}" data-mode="short">break 5</button>
        <button type="button" class="focus-mode-btn ${focusMode === "long" ? "active" : ""}" data-mode="long">break 15</button>
      </div>
      <div class="focus-timer">
        <div class="focus-time" id="focus-time">${formatTime(focusRemaining)}</div>
        <div class="focus-bar-track"><div class="focus-bar" id="focus-bar" style="width:${((1 - focusRemaining / FOCUS_DURATIONS[focusMode]) * 100).toFixed(2)}%"></div></div>
      </div>
      <div class="focus-controls">
        <button type="button" id="focus-toggle" class="focus-btn primary">${focusRunning ? "pause" : "start"}</button>
        <button type="button" id="focus-reset" class="focus-btn">reset</button>
        <button type="button" id="focus-done" class="focus-btn">mark task done</button>
        <button type="button" id="focus-clear" class="focus-btn ghost">switch task</button>
      </div>
    `;
    listEl.appendChild(wrap);

    wrap.querySelectorAll(".focus-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        pauseTimer();
        focusMode = btn.dataset.mode;
        focusRemaining = FOCUS_DURATIONS[focusMode];
        renderAll();
      });
    });
    document.getElementById("focus-toggle").addEventListener("click", () => {
      if (focusRunning) pauseTimer(); else startTimer();
    });
    document.getElementById("focus-reset").addEventListener("click", resetTimer);
    document.getElementById("focus-done").addEventListener("click", () => markDoneFromFocus(activeTask.id));
    document.getElementById("focus-clear").addEventListener("click", () => {
      pauseTimer();
      focusTaskId = null;
      renderAll();
    });
  }

  function startTimer() {
    if (focusRunning) return;
    focusRunning = true;
    updateFocusControls();
    focusInterval = setInterval(() => {
      focusRemaining -= 1;
      updateFocusDisplay();
      if (focusRemaining <= 0) {
        clearInterval(focusInterval);
        focusRunning = false;
        onFocusComplete();
      }
    }, 1000);
  }

  function pauseTimer() {
    clearInterval(focusInterval);
    focusRunning = false;
    updateFocusControls();
  }

  function resetTimer() {
    pauseTimer();
    focusRemaining = FOCUS_DURATIONS[focusMode];
    updateFocusDisplay();
  }

  function onFocusComplete() {
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    if (focusMode === "focus") {
      stats.focusSessionsTotal += 1;
      stats.focusMinutesTotal += Math.round(FOCUS_DURATIONS.focus / 60);
      saveStats();
      recordActivity();
      showToast("Focus session complete \u2014 nice work.");
      focusMode = "short";
    } else {
      showToast("Break's over \u2014 ready for another round?");
      focusMode = "focus";
    }
    focusRemaining = FOCUS_DURATIONS[focusMode];
    updateFocusControls();
    renderAll();
  }

  function markDoneFromFocus(id) {
    pauseTimer();
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    t.status = "done";
    saveTask(t);
    recordActivity();
    showToast("Tossed onto the done pile.");
    focusTaskId = null;
    renderBoardTabs();
    renderAll();
  }

  function updateFocusDisplay() {
    const timeEl = document.getElementById("focus-time");
    const barEl = document.getElementById("focus-bar");
    if (timeEl) timeEl.textContent = formatTime(focusRemaining);
    if (barEl) barEl.style.width = ((1 - focusRemaining / FOCUS_DURATIONS[focusMode]) * 100).toFixed(2) + "%";
    if (focusStatusBadgeEl) {
      if (focusRunning) {
        focusStatusBadgeEl.hidden = false;
        focusStatusBadgeEl.textContent = `\u23F3 ${formatTime(focusRemaining)}`;
      } else {
        focusStatusBadgeEl.hidden = true;
      }
    }
  }

  function updateFocusControls() {
    const toggleBtn = document.getElementById("focus-toggle");
    if (toggleBtn) toggleBtn.textContent = focusRunning ? "pause" : "start";
    updateFocusDisplay();
  }

  // ---------- Profile ----------
  function renderProfileView() {
    emptyEl.hidden = true;
    noResultsEl.hidden = true;

    const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
    const name = user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : "Guest";
    const handle = user && user.username ? "@" + user.username : (tg ? "" : "open inside Telegram to sync your profile");
    const initials = (name.match(/\S+/g) || []).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?";
    const photoHtml = user && user.photo_url
      ? `<img class="profile-photo" src="${user.photo_url}" alt="" />`
      : `<div class="profile-photo profile-initials">${escapeHtml(initials)}</div>`;

    const wrap = document.createElement("div");
    wrap.className = "profile-view";
    wrap.innerHTML = `
      <div class="profile-head">
        ${photoHtml}
        <div>
          <div class="profile-name">${escapeHtml(name)}</div>
          <div class="profile-handle">${escapeHtml(handle)}</div>
        </div>
      </div>
      <div class="profile-stats">
        <div class="stat-card"><div class="stat-value">\uD83D\uDD25 ${streak.count}</div><div class="stat-label">day streak</div></div>
        <div class="stat-card"><div class="stat-value">${streak.longest || 0}</div><div class="stat-label">longest streak</div></div>
        <div class="stat-card"><div class="stat-value">${stats.tasksAdded}</div><div class="stat-label">tasks added</div></div>
        <div class="stat-card" id="stat-pending"><div class="stat-value">\u2026</div><div class="stat-label">pending</div></div>
        <div class="stat-card" id="stat-due"><div class="stat-value">\u2026</div><div class="stat-label">due / overdue</div></div>
        <div class="stat-card"><div class="stat-value">${stats.focusSessionsTotal}</div><div class="stat-label">focus sessions</div></div>
      </div>
    `;
    listEl.appendChild(wrap);

    loadAllTasksAcrossBoards().then((all) => {
      const today = toDateKey(new Date());
      const pending = all.filter((t) => t.status !== "done").length;
      const due = all.filter((t) => t.status !== "done" && t.due && t.due <= today).length;
      const pendEl = document.getElementById("stat-pending");
      const dueEl = document.getElementById("stat-due");
      if (pendEl) pendEl.querySelector(".stat-value").textContent = pending;
      if (dueEl) dueEl.querySelector(".stat-value").textContent = due;
    });
  }

  function renderKanbanCard(task) {
    const card = document.createElement("div");
    card.className = "kcard";
    card.dataset.id = task.id;
    const tagsHtml = (task.tags || []).map((t) => `<span class="kdot" style="background:${t.color}" title="${escapeHtml(t.name)}"></span>`).join("");
    card.innerHTML = `${escapeHtml(task.title)}${tagsHtml ? `<div class="kcard-tags">${tagsHtml}</div>` : ""}`;
    wireKanbanDrag(card);
    return card;
  }

  // ---------- Ticket (list / archive) ----------
  function renderTicket(task, { archived }) {
    const el = document.createElement("article");
    el.className = "ticket" + (archived ? " stub" : "");
    el.dataset.id = task.id;

    const meta = [];
    const due = formatDueFull(task);
    if (due) meta.push(`<span class="pill">due ${escapeHtml(due)}</span>`);
    if (task.priority && task.priority !== "none") {
      meta.push(`<span class="pill ${task.priority === "high" ? "high" : ""}">${escapeHtml(task.priority)}</span>`);
    }
    for (const t of task.tags || []) {
      meta.push(`<span class="pill mini-tag"><span class="dot" style="background:${t.color}"></span>${escapeHtml(t.name)}</span>`);
    }

    const subCount = (task.subtasks || []).length;
    const subDone = (task.subtasks || []).filter((s) => s.done).length;
    const isOpen = expanded.has(task.id);
    const expandLabel = isOpen ? "hide" : (task.notes || subCount || (task.tags || []).length ? `details${subCount ? ` · ${subDone}/${subCount}` : ""}` : "add details");

    el.innerHTML = `
      <div class="ticket-body">
        ${archived ? "" : `<span class="handle" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <circle cx="8" cy="6" r="1.6"/><circle cx="16" cy="6" r="1.6"/>
            <circle cx="8" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/>
            <circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/>
          </svg>
        </span>`}
        ${archived ? "" : `<button class="check" aria-label="Mark done">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>
        </button>`}
        <div class="ticket-text">
          <div class="ticket-title">${escapeHtml(task.title)}</div>
          <div class="ticket-meta">
            ${meta.join("")}
            <button class="expand-btn">${expandLabel}</button>
          </div>
        </div>
      </div>
      ${isOpen ? renderDetail(task) : ""}
      <div class="perf"></div>
      <div class="ticket-actions">
        ${archived
          ? `<button class="toss-btn restore-btn" aria-label="Restore task">restore</button>`
          : `<button class="toss-btn" aria-label="Toss into a chat">
               <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 12l19-9-6 9 6 9-19-9z"/></svg>
               Toss
             </button>
             <button class="focus-launch-btn" aria-label="Focus on this task" title="Focus on this task">\u23F3</button>`}
        <button class="delete-btn" aria-label="Delete task">delete</button>
      </div>
    `;

    if (!archived) {
      el.querySelector(".check").addEventListener("click", () => completeTask(task.id, el));
      el.querySelector(".toss-btn").addEventListener("click", (e) => tossTask(task, e.currentTarget));
      el.querySelector(".focus-launch-btn").addEventListener("click", () => {
        pauseTimer();
        focusTaskId = task.id;
        focusMode = "focus";
        focusRemaining = FOCUS_DURATIONS.focus;
        view = "focus";
        renderBoardTabs();
        renderAll();
      });
      wireHandle(el);
    } else {
      el.querySelector(".restore-btn").addEventListener("click", () => restoreTask(task.id));
    }
    el.querySelector(".delete-btn").addEventListener("click", () => deleteTask(task.id));
    el.querySelector(".expand-btn").addEventListener("click", () => toggleExpanded(task.id));
    wireDetail(el, task);

    return el;
  }

  function renderDetail(task) {
    const subs = (task.subtasks || []).map((s) => `
      <div class="subtask-row ${s.done ? "done" : ""}" data-sub-id="${s.id}">
        <button class="check ${s.done ? "checked" : ""}" aria-label="Toggle subtask">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>
        </button>
        <span class="sub-title">${escapeHtml(s.title)}</span>
        <button class="sub-delete" aria-label="Remove subtask">×</button>
      </div>
    `).join("");

    const tagPills = (task.tags || []).map((t) => `
      <span class="editable-tag" style="background:${t.color}" data-tag-name="${escapeHtml(t.name)}">
        ${escapeHtml(t.name)}<button aria-label="Remove tag">×</button>
      </span>
    `).join("");

    return `
      <div class="detail">
        <div class="edit-fields">
          <input type="text" class="edit-title" value="${escapeHtml(task.title)}" maxlength="140" aria-label="Task title" />
          <div class="edit-row">
            <select class="edit-priority" aria-label="Priority">
              <option value="none">no rush</option>
              <option value="low">low</option>
              <option value="med">medium</option>
              <option value="high">high</option>
            </select>
            <input type="date" class="edit-due" value="${task.due || ""}" aria-label="Due date" />
            <input type="time" class="edit-due-time" value="${task.dueTime || ""}" aria-label="Due time" />
          </div>
          <div class="edit-board-row">
            <label for="edit-board-${task.id}">board</label>
            <select id="edit-board-${task.id}" class="edit-board" aria-label="Move to board">
              ${boards.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("")}
            </select>
          </div>
        </div>
        <textarea class="notes-input" placeholder="Notes…">${escapeHtml(task.notes || "")}</textarea>
        <div class="subtasks">${subs}</div>
        <div class="add-subtask">
          <input type="text" class="sub-input" placeholder="Add a checklist item…" maxlength="120" />
          <button type="button" class="sub-add-btn">+</button>
        </div>
        <div class="tag-editor">
          <div class="tag-editor-label">tags</div>
          ${tagPills}
        </div>
        <div class="add-tag">
          <input type="text" class="tag-input" placeholder="Add a tag…" maxlength="20" />
          <button type="button" class="tag-add-btn">+</button>
        </div>
      </div>
    `;
  }

  function wireDetail(el, task) {
    const editTitle = el.querySelector(".edit-title");
    if (editTitle) {
      let tt;
      editTitle.addEventListener("input", () => {
        clearTimeout(tt);
        tt = setTimeout(() => {
          const val = editTitle.value.trim();
          if (!val) return;
          task.title = val;
          saveTask(task);
          const titleEl = el.querySelector(".ticket-title");
          if (titleEl) titleEl.textContent = val;
          renderBoardTabs();
        }, 400);
      });
    }

    const editPriority = el.querySelector(".edit-priority");
    if (editPriority) {
      editPriority.value = task.priority || "none";
      editPriority.addEventListener("change", () => {
        task.priority = editPriority.value;
        saveTask(task);
        renderAll();
      });
    }

    const editDue = el.querySelector(".edit-due");
    if (editDue) {
      editDue.addEventListener("change", () => {
        task.due = editDue.value || null;
        if (!task.due) task.dueTime = null;
        saveTask(task);
        renderAll();
      });
    }

    const editDueTime = el.querySelector(".edit-due-time");
    if (editDueTime) {
      editDueTime.addEventListener("change", () => {
        task.dueTime = editDueTime.value || null;
        saveTask(task);
        renderAll();
      });
    }

    const editBoard = el.querySelector(".edit-board");
    if (editBoard) {
      editBoard.value = task.boardId || activeBoardId;
      editBoard.addEventListener("change", () => {
        const newBoardId = editBoard.value;
        if (newBoardId !== activeBoardId) moveTaskToBoard(task, newBoardId);
      });
    }

    const textarea = el.querySelector(".notes-input");
    if (textarea) {
      let t;
      textarea.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(() => { task.notes = textarea.value; saveTask(task); }, 400);
      });
    }

    el.querySelectorAll(".subtask-row").forEach((row) => {
      const subId = row.dataset.subId;
      row.querySelector(".check").addEventListener("click", () => {
        const sub = task.subtasks.find((s) => s.id === subId);
        sub.done = !sub.done;
        saveTask(task);
        renderAll();
      });
      row.querySelector(".sub-delete").addEventListener("click", () => {
        task.subtasks = task.subtasks.filter((s) => s.id !== subId);
        saveTask(task);
        renderAll();
      });
    });

    const subInput = el.querySelector(".sub-input");
    if (subInput) {
      const addSub = () => {
        const val = subInput.value.trim();
        if (!val) return;
        task.subtasks = task.subtasks || [];
        task.subtasks.push({ id: uid(), title: val, done: false });
        saveTask(task);
        renderAll();
      };
      el.querySelector(".sub-add-btn").addEventListener("click", addSub);
      subInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSub(); } });
    }

    el.querySelectorAll(".editable-tag button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const name = e.target.closest(".editable-tag").dataset.tagName;
        task.tags = (task.tags || []).filter((t) => t.name !== name);
        saveTask(task);
        renderAll();
      });
    });

    const tagInput = el.querySelector(".tag-input");
    if (tagInput) {
      const addTag = () => {
        const val = tagInput.value.trim();
        if (!val) return;
        task.tags = task.tags || [];
        if (task.tags.some((t) => t.name.toLowerCase() === val.toLowerCase())) { tagInput.value = ""; return; }
        task.tags.push({ name: val, color: hashColor(val, TAG_PALETTE) });
        saveTask(task);
        renderAll();
      };
      el.querySelector(".tag-add-btn").addEventListener("click", addTag);
      tagInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } });
    }
  }

  function toggleExpanded(id) {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    renderAll();
  }

  // ---------- Actions ----------
  function addTask(title, priority, due, dueTime) {
    const task = {
      id: uid(), boardId: activeBoardId, title: title.trim(),
      priority: priority || "none", due: due || null, dueTime: dueTime || null,
      status: "todo", notes: "", subtasks: [], tags: [], createdAt: Date.now()
    };
    tasks.unshift(task);
    saveTask(task);
    persistOrder();
    stats.tasksAdded += 1;
    saveStats();
    renderBoardTabs();
    renderAll();
  }

  function persistOrder() { saveIndex(activeBoardId, tasks.map((t) => t.id)); }

  function completeTask(id, ticketEl) {
    // Signature tear-off: animate, then archive the task.
    ticketEl.classList.add("tearing");
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    setTimeout(() => {
      const t = tasks.find((x) => x.id === id);
      if (!t) return;
      t.status = "done";
      saveTask(t);
      recordActivity();
      renderBoardTabs();
      renderAll();
    }, 480);
  }

  function restoreTask(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    t.status = "todo";
    saveTask(t);
    renderBoardTabs();
    renderAll();
  }

  function deleteTask(id) {
    tasks = tasks.filter((x) => x.id !== id);
    expanded.delete(id);
    deleteTaskFromStore(id);
    persistOrder();
    renderBoardTabs();
    renderAll();
  }

  async function moveTaskToBoard(task, newBoardId) {
    tasks = tasks.filter((t) => t.id !== task.id);
    expanded.delete(task.id);
    persistOrder();

    const raw = await store.get(indexKey(newBoardId));
    let ids = [];
    try { ids = JSON.parse(raw || "[]"); } catch { ids = []; }
    ids.unshift(task.id);
    saveIndex(newBoardId, ids);

    task.boardId = newBoardId;
    saveTask(task);

    const boardName = boards.find((b) => b.id === newBoardId);
    showToast(`Moved to ${boardName ? boardName.name : "board"}`);
    renderBoardTabs();
    renderAll();
  }

  function buildTossText(task) {
    const box = task.status === "done" ? "\u2611" : "\u2610";
    let line = `${box} ${task.title}`;
    const bits = [];
    if (task.due) bits.push(`due ${formatDueFull(task)}`);
    if (task.priority && task.priority !== "none") bits.push(task.priority);
    if ((task.tags || []).length) bits.push(task.tags.map((t) => "#" + t.name).join(" "));
    if (bits.length) line += `  —  ${bits.join(" · ")}`;

    const subs = task.subtasks || [];
    if (subs.length) line += "\n" + subs.map((s) => `  ${s.done ? "\u2611" : "\u2610"} ${s.title}`).join("\n");
    if (task.notes && task.notes.trim()) line += `\n\n${task.notes.trim()}`;
    return line + "\n\nsent via TaskToss";
  }

  function tossTask(task, btn) {
    const text = buildTossText(task);
    btn.classList.add("throwing");
    setTimeout(() => btn.classList.remove("throwing"), 400);
    const shareUrl = `https://t.me/share/url?url=&text=${encodeURIComponent(text)}`;
    if (tg && tg.openTelegramLink) tg.openTelegramLink(shareUrl);
    else window.open(shareUrl, "_blank");
    showToast("Pick a chat to toss it into…");
    if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("medium");
  }

  // ---------- Drag to reorder (list view) ----------
  function wireHandle(el) {
    const handle = el.querySelector(".handle");
    if (!handle) return;
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const dragging = el;
      dragging.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const target = document.elementsFromPoint(ev.clientX, ev.clientY)
          .find((n) => n.classList && n.classList.contains("ticket") && n !== dragging);
        if (!target) return;
        const rect = target.getBoundingClientRect();
        const before = ev.clientY < rect.top + rect.height / 2;
        target.parentNode.insertBefore(dragging, before ? target : target.nextSibling);
      };
      const onUp = () => {
        dragging.classList.remove("dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const newOrderIds = [...listEl.querySelectorAll(".ticket")].map((n) => n.dataset.id);
        const visibleSet = new Set(newOrderIds);
        const reordered = newOrderIds.map((tid) => tasks.find((t) => t.id === tid));
        const untouched = tasks.filter((t) => !visibleSet.has(t.id));
        tasks = [...reordered, ...untouched];
        persistOrder();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  // ---------- Drag between kanban columns ----------
  function wireKanbanDrag(card) {
    card.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      card.classList.add("dragging");
      card.setPointerCapture(e.pointerId);
      let hoverCol = null;

      const onMove = (ev) => {
        const col = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.classList && n.classList.contains("board-col"));
        if (hoverCol && hoverCol !== col) hoverCol.classList.remove("drop-hover");
        if (col) col.classList.add("drop-hover");
        hoverCol = col || hoverCol;
      };
      const onUp = () => {
        card.classList.remove("dragging");
        document.querySelectorAll(".board-col").forEach((c) => c.classList.remove("drop-hover"));
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (hoverCol) {
          const newStatus = hoverCol.dataset.status;
          const task = tasks.find((t) => t.id === card.dataset.id);
          if (task && task.status !== newStatus) {
            task.status = newStatus;
            saveTask(task);
            renderBoardTabs();
            if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
          }
        }
        renderAll();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  // ---------- Form & controls ----------
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    if (!title) return;
    addTask(title, priorityInput.value, dueInput.value, dueTimeInput.value);
    titleInput.value = "";
    priorityInput.value = "none";
    dueInput.value = "";
    dueTimeInput.value = "";
    titleInput.focus();
  });

  searchInput.addEventListener("input", () => { searchQuery = searchInput.value; renderAll(); });
  viewListBtn.addEventListener("click", () => { view = "list"; renderAll(); });
  viewBoardBtn.addEventListener("click", () => { view = "board"; renderAll(); });
  viewCalendarBtn.addEventListener("click", () => { view = "calendar"; renderAll(); });
  viewArchiveBtn.addEventListener("click", () => { view = "archive"; renderAll(); });
  viewFocusBtn.addEventListener("click", () => { view = "focus"; renderAll(); });
  viewProfileBtn.addEventListener("click", () => { view = "profile"; renderAll(); });

  // ---------- Init ----------
  (async () => {
    boards = await loadBoards();
    const savedActive = await store.get(ACTIVE_BOARD_KEY);
    activeBoardId = boards.some((b) => b.id === savedActive) ? savedActive : boards[0].id;
    tasks = await loadTasksForBoard(activeBoardId);
    streak = await loadJSON(STREAK_KEY, { count: 0, longest: 0, lastActiveDate: null });
    stats = await loadJSON(STATS_KEY, { tasksAdded: 0, focusSessionsTotal: 0, focusMinutesTotal: 0 });
    updateStreakBadge();
    renderBoardTabs();
    renderAll();
  })();
})();
