/* ============================================
   ALIMI WORKFLOW DASHBOARD
   ============================================ */

const DAILY_GOAL_MIN = 30;
const STORAGE_KEY = "alimi_dashboard_v1";

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
};

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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Save failed", e);
  }
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
function renderGoals() {
  const list = $("goalList");
  list.innerHTML = "";
  state.goals.forEach((g) => {
    const li = document.createElement("li");
    li.className = "goal-item";
    li.innerHTML = `
      <span class="goal-dot"></span>
      <span class="goal-text"></span>
      <button class="goal-delete" title="Löschen">×</button>
    `;
    li.querySelector(".goal-text").textContent = g.text;
    li.querySelector(".goal-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      state.goals = state.goals.filter((x) => x.id !== g.id);
      save();
      renderGoals();
    });
    list.appendChild(li);
  });
  $("goalsCount").textContent = state.goals.length;
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
