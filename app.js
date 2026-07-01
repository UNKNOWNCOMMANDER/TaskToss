(() => {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const INDEX_KEY = "tasktoss_index_v2";
  const TASK_PREFIX = "tasktoss_task_";

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
  // Each task lives under its own key (tasktoss_task_<id>), well under Telegram's
  // 4096-char-per-value limit even with notes + subtasks. A separate index key
  // just holds the ordered list of ids. Falls back to localStorage outside Telegram.
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
      if (tg && tg.CloudStorage) {
        tg.CloudStorage.removeItem(key);
      } else {
        localStorage.removeItem(key);
      }
    }
  };

  function saveIndex(ids) { store.set(INDEX_KEY, JSON.stringify(ids)); }
  function saveTask(task) { store.set(TASK_PREFIX + task.id, JSON.stringify(task)); }
  function deleteTaskFromStore(id) { store.remove(TASK_PREFIX + id); }

  async function loadAll() {
    const indexRaw = await store.get(INDEX_KEY);
    let ids = [];
    try { ids = JSON.parse(indexRaw || "[]"); } catch { ids = []; }
    if (!ids.length) return [];

    const keys = ids.map((id) => TASK_PREFIX + id);
    const values = await store.getMulti(keys);
    const loaded = [];
    for (const id of ids) {
      const raw = values[TASK_PREFIX + id];
      if (!raw) continue;
      try { loaded.push(JSON.parse(raw)); } catch { /* skip corrupt entry */ }
    }
    return loaded;
  }

  // ---------- State ----------
  let tasks = [];            // ordered array, source of truth for render order
  let expanded = new Set();  // task ids currently showing notes/subtasks
  let searchQuery = "";
  let showDone = true;

  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty-state");
  const noResultsEl = document.getElementById("no-results");
  const form = document.getElementById("add-form");
  const titleInput = document.getElementById("title-input");
  const priorityInput = document.getElementById("priority-input");
  const dueInput = document.getElementById("due-input");
  const searchInput = document.getElementById("search-input");
  const showDoneToggle = document.getElementById("show-done-toggle");
  const toastEl = document.getElementById("toast");

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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

  function persistOrder() { saveIndex(tasks.map((t) => t.id)); }

  // ---------- Render ----------
  function visibleTasks() {
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (!showDone && t.done) return false;
      if (!q) return true;
      const haystack = [t.title, t.notes || "", ...(t.subtasks || []).map((s) => s.title)]
        .join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }

  function render() {
    listEl.innerHTML = "";
    emptyEl.hidden = tasks.length > 0;

    const visible = visibleTasks();
    noResultsEl.hidden = !(tasks.length > 0 && visible.length === 0);

    for (const task of visible) {
      listEl.appendChild(renderTicket(task));
    }
  }

  function renderTicket(task) {
    const el = document.createElement("article");
    el.className = "ticket" + (task.done ? " done" : "");
    el.dataset.id = task.id;

    const meta = [];
    const due = formatDue(task.due);
    if (due) meta.push(`<span class="pill">due ${escapeHtml(due)}</span>`);
    if (task.priority && task.priority !== "none") {
      meta.push(`<span class="pill ${task.priority === "high" ? "high" : ""}">${escapeHtml(task.priority)}</span>`);
    }
    const subCount = (task.subtasks || []).length;
    const subDone = (task.subtasks || []).filter((s) => s.done).length;
    const isOpen = expanded.has(task.id);
    const expandLabel = isOpen ? "hide" : (task.notes || subCount ? `notes${subCount ? ` · ${subDone}/${subCount}` : ""}` : "add notes");

    el.innerHTML = `
      <div class="ticket-body">
        <span class="handle" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <circle cx="8" cy="6" r="1.6"/><circle cx="16" cy="6" r="1.6"/>
            <circle cx="8" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/>
            <circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/>
          </svg>
        </span>
        <button class="check ${task.done ? "checked" : ""}" aria-label="Mark done">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <path d="M4 12l6 6L20 6"/>
          </svg>
        </button>
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
        <button class="toss-btn" aria-label="Toss into a chat">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 12l19-9-6 9 6 9-19-9z"/></svg>
          Toss
        </button>
        <button class="delete-btn" aria-label="Delete task">delete</button>
      </div>
    `;

    el.querySelector(".check").addEventListener("click", () => toggleDone(task.id));
    el.querySelector(".toss-btn").addEventListener("click", (e) => tossTask(task, e.currentTarget));
    el.querySelector(".delete-btn").addEventListener("click", () => deleteTask(task.id));
    el.querySelector(".expand-btn").addEventListener("click", () => toggleExpanded(task.id));
    wireDetail(el, task);
    wireHandle(el);

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

    return `
      <div class="detail">
        <textarea class="notes-input" placeholder="Notes…">${escapeHtml(task.notes || "")}</textarea>
        <div class="subtasks">${subs}</div>
        <div class="add-subtask">
          <input type="text" class="sub-input" placeholder="Add a checklist item…" maxlength="120" />
          <button type="button" class="sub-add-btn">+</button>
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
        t = setTimeout(() => {
          task.notes = textarea.value;
          saveTask(task);
        }, 400);
      });
    }

    el.querySelectorAll(".subtask-row").forEach((row) => {
      const subId = row.dataset.subId;
      row.querySelector(".check").addEventListener("click", () => {
        const sub = task.subtasks.find((s) => s.id === subId);
        sub.done = !sub.done;
        saveTask(task);
        render();
      });
      row.querySelector(".sub-delete").addEventListener("click", () => {
        task.subtasks = task.subtasks.filter((s) => s.id !== subId);
        saveTask(task);
        render();
      });
    });

    const subInput = el.querySelector(".sub-input");
    const subAddBtn = el.querySelector(".sub-add-btn");
    if (subInput) {
      const addSub = () => {
        const val = subInput.value.trim();
        if (!val) return;
        task.subtasks = task.subtasks || [];
        task.subtasks.push({ id: uid(), title: val, done: false });
        saveTask(task);
        render();
      };
      subAddBtn.addEventListener("click", addSub);
      subInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSub(); } });
    }
  }

  function toggleExpanded(id) {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    render();
  }

  // ---------- Actions ----------
  function addTask(title, priority, due) {
    const task = {
      id: uid(),
      title: title.trim(),
      priority: priority || "none",
      due: due || null,
      done: false,
      notes: "",
      subtasks: [],
      createdAt: Date.now()
    };
    tasks.unshift(task);
    saveTask(task);
    persistOrder();
    render();
  }

  function toggleDone(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    saveTask(t);
    render();
    if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
  }

  function deleteTask(id) {
    tasks = tasks.filter((x) => x.id !== id);
    expanded.delete(id);
    deleteTaskFromStore(id);
    persistOrder();
    render();
  }

  function buildTossText(task) {
    const box = task.done ? "\u2611" : "\u2610";
    let line = `${box} ${task.title}`;
    const bits = [];
    if (task.due) bits.push(`due ${formatDue(task.due)}`);
    if (task.priority && task.priority !== "none") bits.push(task.priority);
    if (bits.length) line += `  —  ${bits.join(" · ")}`;

    const subs = (task.subtasks || []);
    if (subs.length) {
      line += "\n" + subs.map((s) => `  ${s.done ? "\u2611" : "\u2610"} ${s.title}`).join("\n");
    }
    if (task.notes && task.notes.trim()) {
      line += `\n\n${task.notes.trim()}`;
    }
    return line + "\n\nsent via TaskToss";
  }

  function tossTask(task, btn) {
    const text = buildTossText(task);

    btn.classList.add("throwing");
    setTimeout(() => btn.classList.remove("throwing"), 400);

    const shareUrl = `https://t.me/share/url?url=&text=${encodeURIComponent(text)}`;
    if (tg && tg.openTelegramLink) {
      tg.openTelegramLink(shareUrl);
    } else {
      window.open(shareUrl, "_blank");
    }

    showToast("Pick a chat to toss it into…");
    if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("medium");
  }

  // ---------- Drag to reorder (pointer events: works for touch and mouse) ----------
  function wireHandle(el) {
    const handle = el.querySelector(".handle");

    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const dragging = el;
      dragging.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const target = document
          .elementsFromPoint(ev.clientX, ev.clientY)
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
        // Re-derive order from the DOM (visible tasks only), keep hidden/filtered tasks
        // wherever they already were relative to the rest.
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

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    render();
  });

  showDoneToggle.addEventListener("change", () => {
    showDone = showDoneToggle.checked;
    render();
  });

  // ---------- Init ----------
  loadAll().then((loaded) => {
    tasks = loaded;
    render();
  });
})();
