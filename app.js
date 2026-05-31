/* ============================================
   ALIMI WORKFLOW DASHBOARD
   ============================================ */

const DAILY_GOAL_MIN = 30;
const STORAGE_KEY = "alimi_dashboard_v1";

// --- SUPABASE SYNC ---
const SUPABASE_URL = "https://tcvokzuxhuklpfoepcyd.supabase.co";
const SUPABASE_KEY = "sb_publishable_PKp63C3RS4NX8QiQot5YNA_Epzsmm7n";
const SYNC_KEY_STORAGE = "alimi_sync_key";
const PUSH_DEBOUNCE_MS = 1500;

// --- STATE ---
const state = {
  goals: [],
  routines: [],        // [{id, text}]
  timer: {
    running: false,
    startedAt: null,   // epoch ms when current run started
    elapsedToday: 0,   // total accumulated seconds today (excluding current run)
  },
  days: {},            // { "2026-05-28": { stamps, totalSec, rewarded, routinesDone: [id...], routinesAllDoneAt: ts|null } }
  streak: 0,
  routineStreak: 0,
  lastRewardedDate: null,
  columnLayout: null,    // { "goals": {x,y,w}, "routines": {...}, "timer": {...}, "history": {...}, "custom_xxx": {...} }
  customColumns: [],     // [{id, title, items: [{id, text, done}]}] — user-created columns
  bgIndex: 0,            // index into BACKGROUNDS for current wallpaper
  updatedAt: 0,          // ms timestamp of last local change — used for sync conflict resolution
};

// Hintergrund-Galerie — der Button oben rechts cycelt durch diese
const BACKGROUNDS = [
  { name: "NYC bei Nacht",     url: "assets/skyline.jpg" },
  { name: "Tokyo Neon",        url: "https://images.unsplash.com/photo-1503899036084-c55cdd92da26?w=1920&q=80&auto=format&fit=crop" },
  { name: "Paris bei Nacht",   url: "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=1920&q=80&auto=format&fit=crop" },
  { name: "Bergpanorama",      url: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1920&q=80&auto=format&fit=crop" },
  { name: "Ozean Sonnenuntergang", url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1920&q=80&auto=format&fit=crop" },
  { name: "Polarlichter",      url: "https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=1920&q=80&auto=format&fit=crop" },
  { name: "Wald im Nebel",     url: "https://images.unsplash.com/photo-1448375240586-882707db888b?w=1920&q=80&auto=format&fit=crop" },
  { name: "Wüstendüne",        url: "https://images.unsplash.com/photo-1473580044384-7ba9967e16a0?w=1920&q=80&auto=format&fit=crop" },
  { name: "Minimal (kein Bild)", url: null },
];

// Default positions for the 4 built-in columns (x,y in px relative to .board, w in px)
const DEFAULT_LAYOUT = {
  goals:    { x: 20,   y: 0, w: 260 },
  routines: { x: 304,  y: 0, w: 260 },
  timer:    { x: 588,  y: 0, w: 420 },
  history:  { x: 1032, y: 0, w: 260 },
};
const COL_DEFAULT_W = 280;
const COL_MIN_W = 200;
const COL_MAX_W = 900;
const COL_GAP = 14;

// --- HELPERS ---
const $ = (id) => document.getElementById(id);
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const formatTime = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const formatHM = (epochMs) => {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const formatDur = (sec) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m} min`;
  return `${m}m ${s}s`;
};
const uid = () => Math.random().toString(36).slice(2, 10);

// --- PERSISTENCE ---
function save() {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Save failed", e);
  }
  schedulePush();
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    Object.assign(state, parsed);
    // Recover from a running timer if app was closed mid-session
    if (state.timer && state.timer.running && state.timer.startedAt) {
      const elapsed = Math.floor((Date.now() - state.timer.startedAt) / 1000);
      state.timer.elapsedToday += elapsed;
      state.timer.running = false;
      state.timer.startedAt = null;
    }
  } catch (e) {
    console.error("Load failed", e);
  }
}

// --- DAY ROLLOVER ---
function ensureToday() {
  const key = todayKey();
  if (!state.days[key]) {
    state.days[key] = {
      stamps: [],
      totalSec: 0,
      rewarded: false,
      routinesDone: [],
      routinesAllDoneAt: null,
    };
    state.timer.elapsedToday = 0;
  }
  // Backfill fields on older day objects
  const d = state.days[key];
  if (!Array.isArray(d.routinesDone)) d.routinesDone = [];
  if (typeof d.routinesAllDoneAt === "undefined") d.routinesAllDoneAt = null;
  return d;
}

// --- GOALS ---
let expandedGoalId = null;

function renderGoals() {
  const list = $("goalList");
  list.innerHTML = "";
  state.goals.forEach((g) => {
    if (typeof g.description === "undefined") g.description = "";
    const isExpanded = g.id === expandedGoalId;
    const hasDesc = (g.description || "").trim().length > 0;

    const li = document.createElement("li");
    li.className = "goal-item" + (isExpanded ? " expanded" : "");
    li.dataset.id = g.id;
    li.innerHTML = `
      <div class="goal-row">
        <span class="goal-dot"></span>
        <span class="goal-text"></span>
        <span class="goal-desc-indicator" title="Hat Beschreibung">≡</span>
        <span class="goal-chevron" aria-hidden="true">▾</span>
        <button class="goal-delete" title="Löschen">×</button>
      </div>
      <div class="goal-expand">
        <label class="goal-edit-label">Titel</label>
        <input type="text" class="goal-title-input" maxlength="120" />
        <label class="goal-edit-label">Beschreibung</label>
        <textarea class="goal-desc-input" rows="4" placeholder="Was genau willst du erreichen? Welche Schritte führen dahin?"></textarea>
        <div class="goal-edit-hint">Wird automatisch gespeichert · Klick auf den Titel oben zum Zuklappen</div>
      </div>
    `;

    li.querySelector(".goal-text").textContent = g.text || "(Ohne Titel)";
    li.querySelector(".goal-desc-indicator").style.display = hasDesc ? "" : "none";
    li.querySelector(".goal-title-input").value = g.text || "";
    li.querySelector(".goal-desc-input").value = g.description || "";

    // Click on row toggles expand
    li.querySelector(".goal-row").addEventListener("click", (e) => {
      if (e.target.classList.contains("goal-delete")) return;
      toggleGoalExpand(g.id);
    });

    // Title edit — live update
    const titleInput = li.querySelector(".goal-title-input");
    titleInput.addEventListener("input", (e) => {
      const newText = e.target.value;
      g.text = newText;
      // Update visible text in collapsed header
      li.querySelector(".goal-text").textContent = newText.trim() || "(Ohne Titel)";
      save();
    });
    // Avoid collapsing when user clicks inside the input
    titleInput.addEventListener("click", (e) => e.stopPropagation());

    // Description edit — live update
    const descInput = li.querySelector(".goal-desc-input");
    descInput.addEventListener("input", (e) => {
      g.description = e.target.value;
      li.querySelector(".goal-desc-indicator").style.display =
        e.target.value.trim() ? "" : "none";
      save();
    });
    descInput.addEventListener("click", (e) => e.stopPropagation());

    // Block expand-area clicks from bubbling (so editing doesn't collapse)
    li.querySelector(".goal-expand").addEventListener("click", (e) => {
      e.stopPropagation();
    });

    li.querySelector(".goal-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      if (g.description && g.description.trim().length > 0) {
        if (!confirm(`"${g.text}" löschen? Beschreibung geht auch verloren.`)) return;
      }
      if (expandedGoalId === g.id) expandedGoalId = null;
      state.goals = state.goals.filter((x) => x.id !== g.id);
      save();
      renderGoals();
    });

    list.appendChild(li);
  });
  $("goalsCount").textContent = state.goals.length;
}

function toggleGoalExpand(id) {
  const wasExpanded = expandedGoalId === id;
  // Collapse all currently-expanded items (smoothly, without re-rendering)
  document.querySelectorAll(".goal-item.expanded").forEach((el) =>
    el.classList.remove("expanded")
  );
  if (!wasExpanded) {
    expandedGoalId = id;
    const el = document.querySelector(`.goal-item[data-id="${id}"]`);
    if (el) el.classList.add("expanded");
  } else {
    expandedGoalId = null;
  }
}

$("addGoalForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("newGoalInput");
  const text = input.value.trim();
  if (!text) return;
  state.goals.push({ id: uid(), text });
  input.value = "";
  save();
  renderGoals();
});

// --- ROUTINES ---
function isRoutineDone(routineId) {
  const day = ensureToday();
  return day.routinesDone.includes(routineId);
}

function renderRoutines() {
  const list = $("routineList");
  list.innerHTML = "";
  const day = ensureToday();
  let doneCount = 0;

  state.routines.forEach((r) => {
    const done = day.routinesDone.includes(r.id);
    if (done) doneCount++;

    const li = document.createElement("li");
    li.className = "routine-item" + (done ? " done" : "");
    li.dataset.id = r.id;
    li.innerHTML = `
      <button class="routine-check" aria-label="Erledigen">
        <svg viewBox="0 0 24 24"><polyline points="5,12 10,17 19,7"/></svg>
      </button>
      <span class="routine-text"></span>
      <button class="routine-delete" title="Löschen">×</button>
    `;
    li.querySelector(".routine-text").textContent = r.text;

    // Click anywhere on the card (except delete) toggles done
    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("routine-delete")) return;
      toggleRoutine(r.id, li);
    });

    li.querySelector(".routine-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      state.routines = state.routines.filter((x) => x.id !== r.id);
      // also remove from any day's routinesDone (just today is fine, history stays)
      const t = ensureToday();
      t.routinesDone = t.routinesDone.filter((id) => id !== r.id);
      save();
      renderRoutines();
    });

    list.appendChild(li);
  });

  const total = state.routines.length;
  const progressEl = $("routinesProgress");
  progressEl.textContent = `${doneCount}/${total}`;
  progressEl.classList.toggle("all-done", total > 0 && doneCount === total);
}

function toggleRoutine(routineId, liEl) {
  const day = ensureToday();
  const idx = day.routinesDone.indexOf(routineId);
  const wasDone = idx !== -1;

  if (wasDone) {
    // Uncheck (allow undo)
    day.routinesDone.splice(idx, 1);
    if (day.routinesAllDoneAt && day.routinesDone.length < state.routines.length) {
      day.routinesAllDoneAt = null;
    }
  } else {
    // Check
    day.routinesDone.push(routineId);
    // small click animation
    if (liEl) {
      liEl.classList.add("popping");
      setTimeout(() => liEl.classList.remove("popping"), 500);
      // mini particle burst from the card
      const rect = liEl.getBoundingClientRect();
      fireMiniParticles(rect.left + 30, rect.top + rect.height / 2);
    }
    playRoutineChime();

    // Check if ALL routines now done
    const allDone = state.routines.length > 0 &&
                    state.routines.every((r) => day.routinesDone.includes(r.id));
    if (allDone && !day.routinesAllDoneAt) {
      day.routinesAllDoneAt = Date.now();
      // Recalc routine streak
      recalcRoutineStreak();
      // Bigger celebration
      setTimeout(() => triggerRoutineReward(), 300);
    }
  }

  save();
  renderRoutines();
  renderRoutineStreak();
}

$("addRoutineForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("newRoutineInput");
  const text = input.value.trim();
  if (!text) return;
  state.routines.push({ id: uid(), text });
  input.value = "";
  save();
  renderRoutines();
});

function recalcRoutineStreak() {
  // Walk back from today: count consecutive days with routinesAllDoneAt set.
  // Today doesn't break the streak if not yet done (we keep yesterday's streak visible).
  let streak = 0;
  let d = new Date();
  let isFirst = true;
  for (;;) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const day = state.days[key];
    const allDone = day && day.routinesAllDoneAt;
    if (allDone) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else if (isFirst) {
      // today not yet done — keep going to see if yesterday was done
      isFirst = false;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
    isFirst = false;
  }
  state.routineStreak = streak;
}

function renderRoutineStreak() {
  $("routineStreakCount").textContent = state.routineStreak;
}

function triggerRoutineReward() {
  // Smaller version of the main reward: mini confetti + sound + badge pulse
  fireConfetti({ count: 80, originY: 80 });
  playSuccessSound();
  const badge = $("routineStreakBadge");
  badge.classList.remove("pulse");
  void badge.offsetWidth; // restart animation
  badge.classList.add("pulse");
  setTimeout(() => badge.classList.remove("pulse"), 700);
}

// --- TIMER ---
let tickInterval = null;

function currentSessionSec() {
  if (!state.timer.running || !state.timer.startedAt) return 0;
  return Math.floor((Date.now() - state.timer.startedAt) / 1000);
}

function totalTodaySec() {
  return state.timer.elapsedToday + currentSessionSec();
}

function renderTimer() {
  const total = totalTodaySec();
  $("timerDisplay").textContent = formatTime(total);
  $("timerDisplay").classList.toggle("running", state.timer.running);

  const goalSec = DAILY_GOAL_MIN * 60;
  const pct = Math.min(100, (total / goalSec) * 100);
  const fill = $("progressFill");
  fill.style.width = pct + "%";
  fill.classList.toggle("completed", total >= goalSec);

  const min = Math.floor(total / 60);
  $("progressText").textContent = `${min} / ${DAILY_GOAL_MIN} min`;

  const goalStatus = $("goalStatus");
  if (total >= goalSec) {
    goalStatus.textContent = "✓ Tagesziel erreicht!";
    goalStatus.classList.add("achieved");
  } else {
    const remaining = Math.ceil((goalSec - total) / 60);
    goalStatus.textContent = `Noch ${remaining} Minuten bis zum Tagesziel`;
    goalStatus.classList.remove("achieved");
  }

  const statusEl = $("timerStatus");
  if (state.timer.running) {
    statusEl.textContent = "Läuft";
    statusEl.classList.add("running");
  } else {
    statusEl.textContent = "Bereit";
    statusEl.classList.remove("running");
  }

  $("startBtn").disabled = state.timer.running;
  $("stopBtn").disabled = !state.timer.running;
}

function startTimer() {
  ensureToday();
  if (state.timer.running) return;
  state.timer.running = true;
  state.timer.startedAt = Date.now();
  save();
  renderTimer();
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    renderTimer();
    checkRewardThreshold();
  }, 1000);
}

function stopTimer() {
  if (!state.timer.running) return;
  const day = ensureToday();
  const sessionSec = currentSessionSec();
  const startMs = state.timer.startedAt;
  const endMs = Date.now();

  if (sessionSec > 0) {
    day.stamps.push({ start: startMs, end: endMs, durationSec: sessionSec });
    day.totalSec += sessionSec;
    state.timer.elapsedToday += sessionSec;
  }
  state.timer.running = false;
  state.timer.startedAt = null;

  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  save();
  renderAll();
}

$("startBtn").addEventListener("click", startTimer);
$("stopBtn").addEventListener("click", stopTimer);

// --- STAMPS ---
function renderStamps() {
  const list = $("stampsList");
  const day = state.days[todayKey()];
  list.innerHTML = "";

  if (!day || day.stamps.length === 0) {
    list.innerHTML = '<div class="empty-state">Noch keine Stempel heute.<br>Drück Start um anzufangen.</div>';
    $("stampsCount").textContent = "0";
    return;
  }

  // Render in reverse chronological order
  [...day.stamps].reverse().forEach((s) => {
    const div = document.createElement("div");
    div.className = "stamp-card";
    div.innerHTML = `
      <span class="stamp-time">${formatHM(s.start)} <span class="stamp-arrow">→</span> ${formatHM(s.end)}</span>
      <span class="stamp-duration">${formatDur(s.durationSec)}</span>
    `;
    list.appendChild(div);
  });
  $("stampsCount").textContent = day.stamps.length;
}

// --- HISTORY (7 days) ---
function renderHistory() {
  const list = $("historyList");
  list.innerHTML = "";
  const goalSec = DAILY_GOAL_MIN * 60;
  const dayNames = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  let weekTotal = 0;

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const day = state.days[key];
    let totalSec = day ? day.totalSec : 0;
    if (key === todayKey()) {
      // include current running time
      totalSec = totalTodaySec();
    }
    weekTotal += totalSec;

    const min = Math.floor(totalSec / 60);
    const pct = Math.min(100, (totalSec / goalSec) * 100);
    const achieved = totalSec >= goalSec;

    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <span class="history-day">${dayNames[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}</span>
      <div class="history-bar">
        <div class="history-bar-fill ${achieved ? "achieved" : "partial"}" style="width: ${pct}%"></div>
      </div>
      <span class="history-mins">${min} min</span>
      <span class="history-check">${achieved ? "✓" : ""}</span>
    `;
    list.appendChild(item);
  }

  const wt = Math.floor(weekTotal / 60);
  $("weekTotal").textContent = wt >= 60
    ? `${Math.floor(wt / 60)}h ${wt % 60}m`
    : `${wt} min`;
}

// --- STREAK ---
function recalcStreak() {
  const goalSec = DAILY_GOAL_MIN * 60;
  let streak = 0;
  let d = new Date();
  // Walk backwards day by day, counting consecutive achieved days
  // Start with today only if achieved
  for (;;) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let total = state.days[key] ? state.days[key].totalSec : 0;
    if (key === todayKey()) total = totalTodaySec();
    if (total >= goalSec) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      // For "today not yet done", still keep streak if yesterday hit it.
      if (key === todayKey()) {
        d.setDate(d.getDate() - 1);
        continue;
      }
      break;
    }
  }
  state.streak = streak;
}

function renderStreak() {
  $("streakCount").textContent = state.streak;
}

// --- DATE in topbar ---
function renderDate() {
  const opts = { weekday: "long", day: "numeric", month: "long" };
  $("todayDate").textContent = new Date().toLocaleDateString("de-DE", opts);
}

// --- REWARD ---
function checkRewardThreshold() {
  const goalSec = DAILY_GOAL_MIN * 60;
  const day = ensureToday();
  if (totalTodaySec() >= goalSec && !day.rewarded) {
    day.rewarded = true;
    recalcStreak();
    save();
    triggerReward();
    renderStreak();
  }
}

function triggerReward() {
  // 1) Sound
  playSuccessSound();
  // 2) Confetti
  fireConfetti();
  // 3) Popup
  const popup = $("rewardPopup");
  const messages = [
    "Du hast heute 30 Minuten an deinen Zielen gearbeitet. Weiter so!",
    "Stark! Jeder Tag wie dieser bringt dich näher an dein Ziel.",
    "Disziplin schlägt Motivation. Du machst es richtig.",
    "Konstanz ist alles. Heute wieder geliefert!",
    "Heute investiert, morgen geerntet. Top!",
  ];
  $("rewardMessage").textContent = messages[Math.floor(Math.random() * messages.length)];
  $("rewardStreakText").textContent = `Streak: ${state.streak} ${state.streak === 1 ? "Tag" : "Tage"}`;
  popup.classList.add("active");
}

$("closeRewardBtn").addEventListener("click", () => {
  $("rewardPopup").classList.remove("active");
});

// --- SOUND (Web Audio) ---
let audioCtx = null;
function playSuccessSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    // Major triad arpeggio: C5, E5, G5, C6
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.1);
      gain.gain.linearRampToValueAtTime(0.18, now + i * 0.1 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.1 + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.1);
      osc.stop(now + i * 0.1 + 0.6);
    });
  } catch (e) {
    console.warn("Sound failed", e);
  }
}

// --- CONFETTI ---
const confettiCanvas = $("confettiCanvas");
const confettiCtx = confettiCanvas.getContext("2d");
let confettiParticles = [];
let confettiRunning = false;

function resizeCanvas() {
  confettiCanvas.width = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function fireConfetti(opts = {}) {
  const colors = opts.colors || ["#4fc3f7", "#66ff8a", "#ffb74d", "#ff5252", "#ba68c8", "#ffeb3b"];
  const burstCount = opts.count || 180;
  const originX = opts.originX != null ? opts.originX : window.innerWidth / 2;
  const originY = opts.originY != null ? opts.originY : window.innerHeight / 2;
  for (let i = 0; i < burstCount; i++) {
    confettiParticles.push({
      x: originX + (Math.random() - 0.5) * 200,
      y: originY,
      vx: (Math.random() - 0.5) * 14,
      vy: -(Math.random() * 14 + 6),
      gravity: 0.35,
      size: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 0.3,
      life: 1,
      decay: 0.005 + Math.random() * 0.008,
    });
  }
  if (!confettiRunning) {
    confettiRunning = true;
    animateConfetti();
  }
}

function fireMiniParticles(x, y) {
  const colors = ["#66ff8a", "#4caf50", "#a5ffb8"];
  for (let i = 0; i < 14; i++) {
    confettiParticles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 7,
      vy: -(Math.random() * 6 + 2),
      gravity: 0.28,
      size: Math.random() * 4 + 2,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: 0,
      vrot: 0,
      life: 1,
      decay: 0.025,
    });
  }
  if (!confettiRunning) {
    confettiRunning = true;
    animateConfetti();
  }
}

function playRoutineChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    // Short two-note chime: G5 → C6
    [783.99, 1046.5].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.08);
      gain.gain.linearRampToValueAtTime(0.14, now + i * 0.08 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.25);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.3);
    });
  } catch (e) {
    console.warn("Chime failed", e);
  }
}

function animateConfetti() {
  confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  confettiParticles.forEach((p) => {
    p.vy += p.gravity;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vrot;
    p.life -= p.decay;
    confettiCtx.save();
    confettiCtx.translate(p.x, p.y);
    confettiCtx.rotate(p.rot);
    confettiCtx.globalAlpha = Math.max(0, p.life);
    confettiCtx.fillStyle = p.color;
    confettiCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
    confettiCtx.restore();
  });
  confettiParticles = confettiParticles.filter(
    (p) => p.life > 0 && p.y < confettiCanvas.height + 50
  );
  if (confettiParticles.length > 0) {
    requestAnimationFrame(animateConfetti);
  } else {
    confettiRunning = false;
    confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  }
}

// --- RENDER ALL ---
function renderAll() {
  renderDate();
  renderGoals();
  renderRoutines();
  renderTimer();
  renderStamps();
  renderHistory();
  renderStreak();
  renderRoutineStreak();
  // Re-render custom columns and re-apply layout (important after sync pulls new state)
  if (typeof renderCustomColumns === "function") renderCustomColumns();
  if (typeof wireColumnDrag === "function") wireColumnDrag();
  if (typeof wireColumnResize === "function") wireColumnResize();
  if (typeof applyLayout === "function") applyLayout();
  if (typeof applyBackground === "function" && typeof state.bgIndex === "number") {
    applyBackground(state.bgIndex);
  }
}

// --- INIT ---
function init() {
  load();
  ensureToday();
  recalcStreak();
  recalcRoutineStreak();

  // Seed defaults on very first run
  if (state.goals.length === 0) {
    state.goals = [
      { id: uid(), text: "Webseite bauen / Home / Webdesign / Socialmediawerbung" },
      { id: uid(), text: "4-5 Testkunden abschliessen" },
      { id: uid(), text: "Fallstudie erstellen" },
    ];
    save();
  }
  if (!state.routines || state.routines.length === 0) {
    state.routines = [
      { id: uid(), text: "Supplemente einnehmen" },
    ];
    save();
  }

  renderAll();
  initSync(); // wire up cloud sync (no-op if no sync key set)

  // Refresh every minute for clock-based UI even if idle
  setInterval(() => {
    renderDate();
    renderHistory();
  }, 60_000);

  // Detect day rollover when window regains focus
  let lastDay = todayKey();
  setInterval(() => {
    const now = todayKey();
    if (now !== lastDay) {
      lastDay = now;
      // If a session was running across midnight, stop it cleanly first
      if (state.timer.running) stopTimer();
      ensureToday(); // creates a fresh day with empty routinesDone -> auto-resets routines
      recalcStreak();
      recalcRoutineStreak();
      renderAll();
    }
  }, 30_000);
}

document.addEventListener("DOMContentLoaded", init);

/* ============================================
   CLOUD SYNC (Supabase)
   ============================================ */

let pushTimer = null;
let pullTimer = null;
let isPulling = false;
let syncState = "idle"; // idle | syncing | synced | error | offline

function getSyncKey() {
  return localStorage.getItem(SYNC_KEY_STORAGE);
}
function setSyncKey(k) {
  if (k) localStorage.setItem(SYNC_KEY_STORAGE, k);
  else localStorage.removeItem(SYNC_KEY_STORAGE);
}
function generateSyncKey() {
  // human-friendly: 4 groups of 4 chars, no confusable chars
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) s += "-";
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

function setSyncStatus(newState, detail = "") {
  syncState = newState;
  const btn = $("syncStatusBtn");
  if (!btn) return;
  btn.dataset.state = newState;
  btn.title = {
    idle: "Sync nicht eingerichtet — klick zum Verbinden",
    syncing: "Synchronisiere …",
    synced: "Synchronisiert ✓",
    error: `Sync-Fehler: ${detail}`,
    offline: "Offline — wird automatisch nachgeholt",
  }[newState] || "Sync";
}

function schedulePush() {
  if (!getSyncKey()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(doPush, PUSH_DEBOUNCE_MS);
}

async function doPush() {
  const key = getSyncKey();
  if (!key) return;
  if (!navigator.onLine) {
    setSyncStatus("offline");
    return;
  }
  setSyncStatus("syncing");
  try {
    const payload = {
      sync_key: key,
      data: state,
      updated_at: new Date(state.updatedAt || Date.now()).toISOString(),
    };
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/sync_data?on_conflict=sync_key`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(payload),
      }
    );
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 100)}`);
    }
    setSyncStatus("synced");
  } catch (e) {
    console.error("Push failed", e);
    setSyncStatus("error", e.message);
  }
}

async function doPull() {
  const key = getSyncKey();
  if (!key) return null;
  if (isPulling) return null;
  if (!navigator.onLine) {
    setSyncStatus("offline");
    return null;
  }
  isPulling = true;
  setSyncStatus("syncing");
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/sync_data?sync_key=eq.${encodeURIComponent(key)}&select=*`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 100)}`);
    }
    const rows = await r.json();
    setSyncStatus("synced");
    return rows[0] || null;
  } catch (e) {
    console.error("Pull failed", e);
    setSyncStatus("error", e.message);
    return null;
  } finally {
    isPulling = false;
  }
}

async function pullAndMerge() {
  const remote = await doPull();
  if (!remote) {
    // no row yet — push our local
    if (state.goals.length > 0 || Object.keys(state.days).length > 0) {
      schedulePush();
    }
    return false;
  }
  const remoteTime = new Date(remote.updated_at).getTime();
  const localTime = state.updatedAt || 0;

  if (remoteTime > localTime + 500) {
    // Server is newer — adopt it
    const wasRunning = state.timer.running;
    const wasStartedAt = state.timer.startedAt;
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, remote.data);
    // Don't clobber an actively-running local timer
    if (wasRunning && wasStartedAt) {
      state.timer.running = true;
      state.timer.startedAt = wasStartedAt;
    }
    ensureToday();
    recalcStreak();
    recalcRoutineStreak();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
    renderAll();
    return true;
  } else if (localTime > remoteTime + 500) {
    // Local is newer — push
    schedulePush();
  }
  return false;
}

function initSync() {
  if (!getSyncKey()) {
    setSyncStatus("idle");
    return;
  }
  // initial pull on startup
  pullAndMerge();

  // pull on focus / visibility change (user switched back to app)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && getSyncKey()) {
      pullAndMerge();
    }
  });
  window.addEventListener("focus", () => {
    if (getSyncKey()) pullAndMerge();
  });

  // periodic background pull every 30s (catches changes from other device)
  if (pullTimer) clearInterval(pullTimer);
  pullTimer = setInterval(() => {
    if (document.visibilityState === "visible" && getSyncKey()) {
      pullAndMerge();
    }
  }, 30_000);

  // retry on going back online
  window.addEventListener("online", () => {
    if (getSyncKey()) {
      pullAndMerge();
      schedulePush();
    }
  });
}

/* ----- Settings Modal logic ----- */

function openSettings() {
  refreshSettingsUI();
  $("settingsModal").classList.add("active");
}
function closeSettings() {
  $("settingsModal").classList.remove("active");
}

function refreshSettingsUI() {
  const key = getSyncKey();
  $("syncKeyDisplay").value = key || "";
  $("syncKeyDisplay").placeholder = key ? "" : "Noch kein Sync-Key gesetzt";
  $("copyKeyBtn").disabled = !key;

  const statusEl = $("syncStatusDetail");
  if (!key) {
    statusEl.textContent = "Status: Kein Sync eingerichtet. Generiere einen Key oder gib einen bestehenden ein.";
    statusEl.className = "sync-status-detail status-idle";
  } else {
    const s = {
      idle: ["Status: Bereit", "status-idle"],
      syncing: ["Status: Synchronisiere …", "status-syncing"],
      synced: ["Status: ✓ Synchronisiert", "status-synced"],
      error: ["Status: ⚠ Sync-Fehler", "status-error"],
      offline: ["Status: Offline (wird nachgeholt)", "status-offline"],
    }[syncState] || ["Status: ?", ""];
    statusEl.textContent = s[0];
    statusEl.className = "sync-status-detail " + s[1];
  }
}

function wireSettingsModal() {
  $("syncStatusBtn").addEventListener("click", openSettings);
  $("settingsClose").addEventListener("click", closeSettings);
  $("settingsModal").addEventListener("click", (e) => {
    if (e.target === $("settingsModal")) closeSettings();
  });

  $("copyKeyBtn").addEventListener("click", async () => {
    const key = getSyncKey();
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      const btn = $("copyKeyBtn");
      const orig = btn.textContent;
      btn.textContent = "✓ Kopiert";
      setTimeout(() => (btn.textContent = orig), 1500);
    } catch (e) {
      // Fallback: select the input
      $("syncKeyDisplay").select();
      document.execCommand("copy");
    }
  });

  $("generateKeyBtn").addEventListener("click", () => {
    const existing = getSyncKey();
    if (existing) {
      if (!confirm("Du hast bereits einen Sync-Key. Ein neuer trennt dich von deinem aktuellen Sync. Wirklich neu generieren?")) return;
    }
    const newKey = generateSyncKey();
    setSyncKey(newKey);
    state.updatedAt = Date.now();
    save();
    refreshSettingsUI();
    initSync();
    setTimeout(() => schedulePush(), 200);
  });

  $("enterKeyBtn").addEventListener("click", () => {
    $("syncSetupView").style.display = "none";
    $("syncEnterView").style.display = "block";
    $("enterKeyInput").value = "";
    setTimeout(() => $("enterKeyInput").focus(), 50);
  });
  $("cancelKeyBtn").addEventListener("click", () => {
    $("syncEnterView").style.display = "none";
    $("syncSetupView").style.display = "block";
  });
  $("confirmKeyBtn").addEventListener("click", async () => {
    const k = $("enterKeyInput").value.trim().toUpperCase();
    if (!k) {
      alert("Bitte einen Sync-Key eingeben.");
      return;
    }
    if (!/^[A-Z0-9\-]{4,}$/.test(k)) {
      if (!confirm("Der Key sieht ungewöhnlich aus. Trotzdem verbinden?")) return;
    }
    setSyncKey(k);
    $("syncEnterView").style.display = "none";
    $("syncSetupView").style.display = "block";
    refreshSettingsUI();
    // Pull immediately to grab data from the other device
    const changed = await pullAndMerge();
    refreshSettingsUI();
    if (!changed) {
      // No remote data yet — push our local under this key
      schedulePush();
    }
    initSync();
  });

  $("enterKeyInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("confirmKeyBtn").click();
  });
}

// Wire up modal on DOM ready (after init)
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(wireSettingsModal, 0);
});

/* ============================================
   FREE-POSITION LAYOUT
   Drag columns by their grip / header to reposition.
   Resize width via right-edge handle.
   ============================================ */

function ensureLayout() {
  if (!state.columnLayout || typeof state.columnLayout !== "object") {
    state.columnLayout = {};
  }
  // Seed built-in columns from DEFAULT_LAYOUT if missing
  Object.keys(DEFAULT_LAYOUT).forEach((id) => {
    if (!state.columnLayout[id]) {
      state.columnLayout[id] = { ...DEFAULT_LAYOUT[id] };
    }
  });
}

function getColLayout(id) {
  ensureLayout();
  if (!state.columnLayout[id]) {
    // Custom column without a position yet — place it to the right of the rightmost column
    let maxRight = 20;
    Object.values(state.columnLayout).forEach((l) => {
      const r = (l.x || 0) + (l.w || COL_DEFAULT_W);
      if (r > maxRight) maxRight = r;
    });
    state.columnLayout[id] = { x: maxRight + COL_GAP, y: 0, w: COL_DEFAULT_W };
  }
  return state.columnLayout[id];
}

function applyLayout() {
  const board = document.querySelector(".board");
  if (!board) return;

  // Mobile/tablet: clear inline positions, let CSS grid take over
  if (window.innerWidth <= 900) {
    board.classList.remove("board-free");
    document.querySelectorAll(".column").forEach((c) => {
      c.style.left = "";
      c.style.top = "";
      c.style.width = "";
    });
    board.style.minHeight = "";
    board.style.minWidth = "";
    return;
  }

  board.classList.add("board-free");

  document.querySelectorAll(".column").forEach((c) => {
    const id = c.dataset.colId;
    if (!id) return;
    const lay = getColLayout(id);
    c.style.left = lay.x + "px";
    c.style.top = lay.y + "px";
    c.style.width = lay.w + "px";
  });

  // Resize board canvas so columns are scrollable when positioned far right/down
  requestAnimationFrame(() => {
    let maxRight = 0;
    let maxBottom = 0;
    document.querySelectorAll(".column").forEach((c) => {
      const id = c.dataset.colId;
      if (!id) return;
      const lay = getColLayout(id);
      const right = lay.x + lay.w;
      const bottom = lay.y + c.offsetHeight;
      if (right > maxRight) maxRight = right;
      if (bottom > maxBottom) maxBottom = bottom;
    });
    board.style.minWidth = (maxRight + 40) + "px";
    board.style.minHeight = Math.max(maxBottom + 100, window.innerHeight - 80) + "px";
  });
}

/* ---- Drag-to-move ---- */
function wireColumnDrag() {
  document.querySelectorAll(".column").forEach((col) => {
    const header = col.querySelector(".column-header");
    if (!header || header.dataset.dragWired === "1") return;
    header.dataset.dragWired = "1";

    const startDrag = (clientX, clientY, srcEvent) => {
      if (window.innerWidth <= 900) return;
      // Don't drag if the user clicked an interactive child
      if (srcEvent.target.closest(
        "button, input, textarea, .col-resize-edge, .goal-delete, .routine-delete, .col-delete, .custom-delete"
      )) return;

      const id = col.dataset.colId;
      if (!id) return;
      const lay = getColLayout(id);
      const startX = clientX;
      const startY = clientY;
      const startLeft = lay.x;
      const startTop = lay.y;

      col.classList.add("dragging");
      document.body.classList.add("col-dragging");

      const onMove = (e) => {
        const x = e.touches ? e.touches[0].clientX : e.clientX;
        const y = e.touches ? e.touches[0].clientY : e.clientY;
        lay.x = Math.max(0, startLeft + (x - startX));
        lay.y = Math.max(0, startTop + (y - startY));
        col.style.left = lay.x + "px";
        col.style.top = lay.y + "px";
        if (e.cancelable) e.preventDefault();
      };
      const onEnd = () => {
        col.classList.remove("dragging");
        document.body.classList.remove("col-dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onEnd);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onEnd);
        applyLayout();   // re-measure canvas size
        save();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onEnd);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd);
    };

    header.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      startDrag(e.clientX, e.clientY, e);
    });
    header.addEventListener("touchstart", (e) => {
      startDrag(e.touches[0].clientX, e.touches[0].clientY, e);
    }, { passive: true });
  });
}

/* ---- Width-resize via right edge ---- */
function wireColumnResize() {
  document.querySelectorAll(".col-resize-edge").forEach((handle) => {
    if (handle.dataset.resizeWired === "1") return;
    handle.dataset.resizeWired = "1";

    const col = handle.closest(".column");
    if (!col) return;

    const startResize = (clientX, srcEvent) => {
      if (window.innerWidth <= 900) return;
      const id = col.dataset.colId;
      if (!id) return;
      const lay = getColLayout(id);
      const startX = clientX;
      const startW = lay.w;

      handle.classList.add("dragging");
      document.body.classList.add("col-resizing");

      const onMove = (e) => {
        const x = e.touches ? e.touches[0].clientX : e.clientX;
        lay.w = Math.max(COL_MIN_W, Math.min(COL_MAX_W, startW + (x - startX)));
        col.style.width = lay.w + "px";
        if (e.cancelable) e.preventDefault();
      };
      const onEnd = () => {
        handle.classList.remove("dragging");
        document.body.classList.remove("col-resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onEnd);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onEnd);
        applyLayout();
        save();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onEnd);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd);
      if (srcEvent && srcEvent.cancelable) srcEvent.preventDefault();
    };

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startResize(e.clientX, e);
    });
    handle.addEventListener("touchstart", (e) => {
      e.stopPropagation();
      startResize(e.touches[0].clientX, e);
    }, { passive: false });

    // Double-click resets width to default
    handle.addEventListener("dblclick", () => {
      const id = col.dataset.colId;
      if (!id) return;
      const lay = getColLayout(id);
      lay.w = (DEFAULT_LAYOUT[id] && DEFAULT_LAYOUT[id].w) || COL_DEFAULT_W;
      col.style.width = lay.w + "px";
      applyLayout();
      save();
    });
  });
}

/* ============================================
   CUSTOM COLUMNS (created via + button)
   ============================================ */

function renderCustomColumns() {
  const board = document.querySelector(".board");
  if (!board) return;
  // Remove existing custom columns from the DOM
  document.querySelectorAll(".column-custom").forEach((c) => c.remove());

  if (!Array.isArray(state.customColumns)) state.customColumns = [];

  state.customColumns.forEach((col) => {
    if (!Array.isArray(col.items)) col.items = [];

    const section = document.createElement("section");
    section.className = "column column-custom";
    section.dataset.colId = col.id;
    section.innerHTML = `
      <div class="column-header">
        <span class="col-grip" title="Ziehen zum Verschieben">⠿</span>
        <span class="col-icon">📝</span>
        <input class="custom-col-title" maxlength="40" />
        <span class="col-count custom-col-count">0</span>
        <button class="col-delete" title="Spalte löschen" aria-label="Spalte löschen">×</button>
      </div>
      <ul class="custom-list"></ul>
      <form class="add-custom-item">
        <span class="add-plus-badge" aria-hidden="true">+</span>
        <input type="text" class="new-custom-item" placeholder="Neuen Eintrag hinzufügen…" maxlength="120" />
        <button type="submit" class="add-custom-submit" title="Hinzufügen" aria-label="Eintrag hinzufügen">+</button>
      </form>
      <div class="col-resize-edge" title="Breite ändern"></div>
    `;

    const titleInput = section.querySelector(".custom-col-title");
    titleInput.value = col.title || "Neue Spalte";
    titleInput.addEventListener("input", (e) => {
      col.title = e.target.value;
      save();
    });
    titleInput.addEventListener("mousedown", (e) => e.stopPropagation());
    titleInput.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

    section.querySelector(".col-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`Spalte "${col.title || "Neue Spalte"}" wirklich löschen?`)) return;
      state.customColumns = state.customColumns.filter((x) => x.id !== col.id);
      if (state.columnLayout) delete state.columnLayout[col.id];
      save();
      renderCustomColumns();
      wireColumnDrag();
      wireColumnResize();
      applyLayout();
    });

    const list = section.querySelector(".custom-list");
    col.items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "custom-item" + (item.done ? " done" : "");
      li.innerHTML = `
        <button class="custom-check" aria-label="${item.done ? "Erledigt" : "Erledigen"}">
          <svg viewBox="0 0 24 24"><polyline points="5,12 10,17 19,7"/></svg>
        </button>
        <span class="custom-text"></span>
        <button class="custom-delete" title="Löschen" aria-label="Eintrag löschen">×</button>
      `;
      li.querySelector(".custom-text").textContent = item.text;

      li.addEventListener("click", (e) => {
        if (e.target.closest(".custom-delete")) return;
        item.done = !item.done;
        li.classList.toggle("done", item.done);
        save();
        section.querySelector(".custom-col-count").textContent = col.items.length;
      });

      li.querySelector(".custom-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        col.items = col.items.filter((x) => x.id !== item.id);
        save();
        renderCustomColumns();
        wireColumnDrag();
        wireColumnResize();
        applyLayout();
      });

      list.appendChild(li);
    });
    section.querySelector(".custom-col-count").textContent = col.items.length;

    section.querySelector(".add-custom-item").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = section.querySelector(".new-custom-item");
      const text = input.value.trim();
      if (!text) return;
      col.items.push({ id: uid(), text, done: false });
      input.value = "";
      save();
      renderCustomColumns();
      wireColumnDrag();
      wireColumnResize();
      applyLayout();
    });

    board.appendChild(section);
  });
}

function addNewCustomColumn() {
  if (!Array.isArray(state.customColumns)) state.customColumns = [];
  ensureLayout();

  const id = "custom_" + uid();
  state.customColumns.push({
    id,
    title: "Neue Spalte",
    items: [],
  });

  // Place to the right of the rightmost existing column
  let maxRight = 0;
  Object.values(state.columnLayout).forEach((l) => {
    const r = (l.x || 0) + (l.w || COL_DEFAULT_W);
    if (r > maxRight) maxRight = r;
  });
  state.columnLayout[id] = { x: maxRight + COL_GAP, y: 0, w: COL_DEFAULT_W };

  save();
  renderCustomColumns();
  wireColumnDrag();
  wireColumnResize();
  applyLayout();

  // Scroll the new column into view + focus the title for immediate rename
  setTimeout(() => {
    const el = document.querySelector(`.column[data-col-id="${id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "end" });
      const titleInput = el.querySelector(".custom-col-title");
      if (titleInput) {
        titleInput.focus();
        titleInput.select();
      }
    }
  }, 50);
}

// Wire everything on DOM ready — runs after init()
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    ensureLayout();
    renderCustomColumns();
    wireColumnDrag();
    wireColumnResize();
    applyLayout();

    // + button
    const addBtn = document.getElementById("addColumnBtn");
    if (addBtn) {
      addBtn.addEventListener("click", addNewCustomColumn);
    }

    // Re-apply layout on window resize (handles mobile breakpoint)
    window.addEventListener("resize", applyLayout);

    // Hintergrund-Switcher
    initBackgroundSwitcher();
  }, 0);
});

/* ============================================
   BACKGROUND SWITCHER
   ============================================ */

function applyBackground(index) {
  const overlay = document.querySelector(".bg-overlay");
  if (!overlay) return;
  if (typeof index !== "number" || index < 0 || index >= BACKGROUNDS.length) index = 0;
  const bg = BACKGROUNDS[index];

  if (bg.url) {
    // Preload then swap to avoid flash of empty bg
    const img = new Image();
    img.onload = () => {
      overlay.style.backgroundImage = `url('${bg.url}')`;
      overlay.style.opacity = "1";
    };
    img.onerror = () => {
      // Fallback to first (local) background if remote URL fails
      console.warn("Background failed to load:", bg.url);
      overlay.style.backgroundImage = `url('${BACKGROUNDS[0].url}')`;
    };
    img.src = bg.url;
  } else {
    // "Minimal" — no image, just the dark canvas
    overlay.style.backgroundImage = "none";
    overlay.style.opacity = "0.6";   // keep gradient overlay visible
  }
}

function showBgToast(name) {
  let toast = document.getElementById("bgToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "bgToast";
    toast.className = "bg-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = "🖼️  " + name;
  // Force reflow then add class
  void toast.offsetWidth;
  toast.classList.add("show");
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 1800);
}

function cycleBackground() {
  if (typeof state.bgIndex !== "number") state.bgIndex = 0;
  state.bgIndex = (state.bgIndex + 1) % BACKGROUNDS.length;
  applyBackground(state.bgIndex);
  showBgToast(BACKGROUNDS[state.bgIndex].name);

  // Animate the button icon
  const btn = document.getElementById("bgSwitchBtn");
  if (btn) {
    btn.classList.remove("cycling");
    void btn.offsetWidth;
    btn.classList.add("cycling");
    setTimeout(() => btn.classList.remove("cycling"), 500);
  }

  save();   // persist + sync to other devices
}

function initBackgroundSwitcher() {
  // Apply persisted background on startup
  if (typeof state.bgIndex === "number" && state.bgIndex > 0) {
    applyBackground(state.bgIndex);
  }
  const btn = document.getElementById("bgSwitchBtn");
  if (btn) btn.addEventListener("click", cycleBackground);
}
