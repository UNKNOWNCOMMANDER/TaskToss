(() => {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  const BOARDS_KEY = "tasktoss_boards_v1";
  const ACTIVE_BOARD_KEY = "tasktoss_active_board_v1";
  const TASK_PREFIX = "tasktoss_task_";
  const indexKey = (boardId) => "tasktoss_index_" + boardId;

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
  let view = "list"; // list | board | archive

  const boardTabsEl = document.getElementById("board-tabs");
  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty-state");
  const noResultsEl = document.getElementById("no-results");
  const tagFilterEl = document.getElementById("tag-filter");
  const form = document.getElementById("add-form");
  const titleInput = document.getElementById("title-input");
  const priorityInput = document.getElementById("priority-input");
  const dueInput = document.getElementById("due-input");
  const searchInput = document.getElementById("search-input");
  const toastEl = document.getElementById("toast");
  const viewListBtn = document.getElementById("view-list-btn");
  const viewBoardBtn = document.getElementById("view-board-btn");
  const viewCalendarBtn = document.getElementById("view-calendar-btn");
  const viewArchiveBtn = document.getElementById("view-archive-btn");

  let calendarWeekStart = startOfWeek(new Date());
  let calendarHiddenBoards = new Set(); // board ids toggled off in the calendar legend

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

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

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
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

    tagFilterEl.hidden = view === "calendar" ? true : tagFilterEl.hidden;
    if (view !== "calendar") renderTagFilter();

    listEl.className = (view === "board" || view === "calendar") ? "" : "tickets";
    listEl.innerHTML = "";

    if (view === "list") renderListView();
    else if (view === "board") renderBoardView();
    else if (view === "calendar") renderCalendarView();
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
    const start = calendarWeekStart;
    const days = [...Array(7)].map((_, i) => addDays(start, i));

    const nav = document.createElement("div");
    nav.className = "cal-nav";
    nav.innerHTML = `
      <button id="cal-prev" aria-label="Previous week">‹</button>
      <button id="cal-today">today</button>
      <button id="cal-next" aria-label="Next week">›</button>
      <span class="cal-range">${formatWeekRange(start)}</span>
    `;
    listEl.appendChild(nav);
    nav.querySelector("#cal-prev").addEventListener("click", () => { calendarWeekStart = addDays(calendarWeekStart, -7); renderAll(); });
    nav.querySelector("#cal-next").addEventListener("click", () => { calendarWeekStart = addDays(calendarWeekStart, 7); renderAll(); });
    nav.querySelector("#cal-today").addEventListener("click", () => { calendarWeekStart = startOfWeek(new Date()); renderAll(); });

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

    const grid = document.createElement("div");
    grid.className = "cal-grid";
    const todayKey = toDateKey(new Date());
    const dayEls = {};
    for (const d of days) {
      const key = toDateKey(d);
      const col = document.createElement("div");
      col.className = "cal-day" + (key === todayKey ? " today" : "");
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

      for (const key of Object.keys(dayEls)) {
        const col = dayEls[key];
        const items = (byDate[key] || []).sort((a, b) => (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1));
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "cal-day-empty";
          empty.textContent = "—";
          col.appendChild(empty);
          continue;
        }
        for (const t of items) {
          const chip = document.createElement("div");
          chip.className = "cal-chip" + (t.status === "done" ? " done" : "");
          chip.style.borderLeftColor = t.boardColor;
          chip.innerHTML = `${escapeHtml(t.title)}<span class="cal-chip-board">${escapeHtml(t.boardName)}</span>`;
          chip.addEventListener("click", async () => {
            if (t.boardId !== activeBoardId) await switchBoard(t.boardId);
            view = "list";
            expanded.add(t.id);
            renderBoardTabs();
            renderAll();
          });
          col.appendChild(chip);
        }
      }
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
    const due = formatDue(task.due);
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
             </button>`}
        <button class="delete-btn" aria-label="Delete task">delete</button>
      </div>
    `;

    if (!archived) {
      el.querySelector(".check").addEventListener("click", () => completeTask(task.id, el));
      el.querySelector(".toss-btn").addEventListener("click", (e) => tossTask(task, e.currentTarget));
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
  function addTask(title, priority, due) {
    const task = {
      id: uid(), boardId: activeBoardId, title: title.trim(),
      priority: priority || "none", due: due || null,
      status: "todo", notes: "", subtasks: [], tags: [], createdAt: Date.now()
    };
    tasks.unshift(task);
    saveTask(task);
    persistOrder();
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

  function buildTossText(task) {
    const box = task.status === "done" ? "\u2611" : "\u2610";
    let line = `${box} ${task.title}`;
    const bits = [];
    if (task.due) bits.push(`due ${formatDue(task.due)}`);
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
    addTask(title, priorityInput.value, dueInput.value);
    titleInput.value = "";
    priorityInput.value = "none";
    dueInput.value = "";
    titleInput.focus();
  });

  searchInput.addEventListener("input", () => { searchQuery = searchInput.value; renderAll(); });
  viewListBtn.addEventListener("click", () => { view = "list"; renderAll(); });
  viewBoardBtn.addEventListener("click", () => { view = "board"; renderAll(); });
  viewCalendarBtn.addEventListener("click", () => { view = "calendar"; renderAll(); });
  viewArchiveBtn.addEventListener("click", () => { view = "archive"; renderAll(); });

  // ---------- Init ----------
  (async () => {
    boards = await loadBoards();
    const savedActive = await store.get(ACTIVE_BOARD_KEY);
    activeBoardId = boards.some((b) => b.id === savedActive) ? savedActive : boards[0].id;
    tasks = await loadTasksForBoard(activeBoardId);
    renderBoardTabs();
    renderAll();
  })();
})();
