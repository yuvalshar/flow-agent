/* ══════════════════════════════════════════════════
   Flow — Meridian
   All logic: schedule, session, timer, ring, transitions
══════════════════════════════════════════════════ */

// ── HTML escaping ───────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Ring geometry ──────────────────────────────────────
const RING_R = 88;
const RING_C = 2 * Math.PI * RING_R; // 552.92

// ── Config ─────────────────────────────────────────────
const WARN_MINUTES = 15;

// ── State ──────────────────────────────────────────────
let schedule        = [];
let sessionStart    = null;
let currentTask     = '';
let sessionActive   = false;
let _restoredNotes  = '';
let warningFired    = false;
let transitionFired = false;
let sessionLog      = [];
let clockInterval      = null;
let _summaryReqId      = 0;
let _pendingTransition = null; // { task, duration, nextTask, notes, summary } — saved to DB only on confirm
let _summaryCache      = null; // { task, nextTask, notes, summary } — reused if inputs unchanged
let targetBlock       = null; // the next block at session-start; used for reliable transition detection
let dashboardInited   = false;

// ── DOM ────────────────────────────────────────────────
const scheduleEntries = document.getElementById('schedule-entries');
const addSlotBtn      = document.getElementById('add-slot-btn');
const startBtn        = document.getElementById('start-btn');
const cancelEditBtn   = document.getElementById('cancel-edit-btn');

const liveClock          = document.getElementById('live-clock');
const sessionTimer       = document.getElementById('session-timer');
const focusInput         = document.getElementById('focus-input');
const focusBtn           = document.getElementById('focus-btn');
const focusHint          = document.getElementById('focus-hint');
const nextItemDisplay    = document.getElementById('next-item-display');
const countdownWrap      = document.getElementById('countdown-bar-wrap');
const countdownText      = document.getElementById('countdown-text');
const countdownValue     = document.getElementById('countdown-value');
const progressFill       = document.getElementById('progress-fill');
const todayScheduleEl    = document.getElementById('today-schedule');
const sessionLogEl       = document.getElementById('session-log');
const switchNowBtn       = document.getElementById('switch-now-btn');
const editScheduleBtn    = document.getElementById('edit-schedule-btn');
const progressRingFill   = document.getElementById('progress-ring-fill');
const curTaskDisplay     = document.getElementById('current-task-display');
const sessionNotes       = document.getElementById('session-notes');
const reentryCard        = document.getElementById('reentry-card');
const reentrySummary     = document.getElementById('reentry-summary');
const ringSubLabel       = document.getElementById('ring-sub-label');
const notifStatus        = document.getElementById('notif-status');

// ── Particles ──────────────────────────────────────────
(function spawnParticles() {
  const container = document.getElementById('particles');
  if (!container) return;
  for (let i = 0; i < 24; i++) {
    const p = document.createElement('div');
    p.className = 'p';
    const size = Math.random() * 2.5 + 1;
    const hue  = Math.random() > 0.5 ? '79,140,255' : '124,108,255';
    p.style.cssText = `
      left:${Math.random() * 100}%;
      top:${100 + Math.random() * 20}%;
      width:${size}px; height:${size}px;
      background:rgba(${hue},${Math.random() * 0.4 + 0.1});
      animation-duration:${Math.random() * 22 + 16}s;
      animation-delay:${-Math.random() * 35}s;
    `;
    container.appendChild(p);
  }
})();

// ── Screen management ──────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Setup screen ───────────────────────────────────────
let draggedRow  = null;
let sortTimeout = null;

function debouncedSort() {
  clearTimeout(sortTimeout);
  sortTimeout = setTimeout(sortScheduleRows, 600);
}

function sortScheduleRows() {
  const rows   = [...scheduleEntries.querySelectorAll('.schedule-row')];
  const sorted = [...rows].sort((a, b) => {
    const ta = a.querySelector('input[type="time"]').value || '99:99';
    const tb = b.querySelector('input[type="time"]').value || '99:99';
    return ta.localeCompare(tb);
  });

  // Nothing to do if order hasn't changed
  if (rows.every((r, i) => r === sorted[i])) return;

  // Record positions before any DOM change
  const first = new Map(sorted.map(r => [r, r.getBoundingClientRect().top]));

  // Reorder — only touch rows that are actually out of place
  for (let i = 0; i < sorted.length; i++) {
    if (scheduleEntries.children[i] !== sorted[i]) {
      scheduleEntries.insertBefore(sorted[i], scheduleEntries.children[i]);
    }
  }

  // Animate only the rows that actually moved
  sorted.forEach(r => {
    const delta = first.get(r) - r.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) return;

    r.style.transition = 'none';
    r.style.transform  = `translateY(${delta}px)`;
    r.getBoundingClientRect(); // force reflow
    r.style.transition = 'transform 0.38s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    r.style.transform  = '';
    r.addEventListener('transitionend', () => { r.style.transition = ''; }, { once: true });
  });
}

function addScheduleRow(time = '', label = '') {
  const row = document.createElement('div');
  row.className = 'schedule-row';
  row.innerHTML = `
    <div class="drag-handle" title="Drag to reorder">
      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
        <circle cx="3" cy="3"  r="1.5"/><circle cx="7" cy="3"  r="1.5"/>
        <circle cx="3" cy="8"  r="1.5"/><circle cx="7" cy="8"  r="1.5"/>
        <circle cx="3" cy="13" r="1.5"/><circle cx="7" cy="13" r="1.5"/>
      </svg>
    </div>
    <input type="time" value="${escapeHtml(time)}">
    <input type="text" value="${escapeHtml(label)}" placeholder="e.g. Violin practice">
    <button class="remove-slot" title="Remove">×</button>
  `;

  row.querySelector('.remove-slot').addEventListener('click', () => row.remove());

  row.querySelector('input[type="time"]').addEventListener('change', debouncedSort);

  const handle = row.querySelector('.drag-handle');
  handle.addEventListener('mousedown', () => { row.draggable = true; });

  row.addEventListener('dragstart', e => {
    draggedRow = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  row.addEventListener('dragend', () => {
    row.draggable = false;
    row.classList.remove('dragging');
    document.querySelectorAll('.schedule-row').forEach(r => r.classList.remove('drag-over'));
    draggedRow = null;
  });

  row.addEventListener('dragover', e => {
    e.preventDefault();
    if (!draggedRow || draggedRow === row) return;
    row.classList.add('drag-over');
    const rect  = row.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    scheduleEntries.insertBefore(draggedRow, after ? row.nextSibling : row);
  });

  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop',      e => { e.preventDefault(); row.classList.remove('drag-over'); });

  scheduleEntries.appendChild(row);
}

// ── Schedule persistence ────────────────────────────────
function saveScheduleToStorage(rows) {
  localStorage.setItem('flow_schedule', JSON.stringify(rows));
}

function loadScheduleFromStorage() {
  try {
    const saved = localStorage.getItem('flow_schedule');
    return saved ? JSON.parse(saved) : null;
  } catch { return null; }
}

const savedRows = loadScheduleFromStorage();
if (savedRows && savedRows.length) {
  savedRows.forEach(r => addScheduleRow(r.time, r.label));
} else {
  addScheduleRow('07:00', 'Gym / Workout');
  addScheduleRow('09:00', 'University / Study');
  addScheduleRow('15:00', 'Violin / Piano');
  addScheduleRow('18:00', 'Startup work');
  addScheduleRow('21:00', 'Self-development');
}

addSlotBtn.addEventListener('click', () => {
  addScheduleRow();
  const rows = scheduleEntries.querySelectorAll('.schedule-row');
  rows[rows.length - 1].querySelector('input[type="time"]').focus();
});

function applyScheduleFromForm() {
  schedule = [];
  scheduleEntries.querySelectorAll('.schedule-row').forEach(row => {
    const time  = row.querySelector('input[type="time"]').value;
    const label = row.querySelector('input[type="text"]').value.trim();
    if (time && label) schedule.push({ time, label });
  });
  if (!schedule.length) return false;
  schedule.sort((a, b) => a.time.localeCompare(b.time));
  saveScheduleToStorage(schedule);
  return true;
}

cancelEditBtn.addEventListener('click', () => {
  // Discard any edits, go straight back — session is still active in memory
  showScreen('dashboard-screen');
  // If a transition fired while the user was editing, show it now.
  if (sessionActive && transitionFired) {
    triggerTransition(targetBlock);
  }
});

startBtn.addEventListener('click', () => {
  if (!applyScheduleFromForm()) return;
  const wasActive = sessionActive;
  if (wasActive && !transitionFired) {
    // Recompute targetBlock from the updated schedule BEFORE initDashboard reads
    // from localStorage — so restoreSessionIfAny() gets the correct state and
    // applyRestoredSessionUI() is only called once.
    // Skip if a transition already fired while editing — initDashboard will
    // re-trigger it via restoreSessionIfAny using the original targetBlock.
    targetBlock = getNextBlock();
    const remaining = targetBlock ? timeToMinutes(targetBlock.time) - getNow() : 999;
    warningFired    = remaining <= WARN_MINUTES;
    transitionFired = remaining <= 0;
    saveSessionState();
  }
  showScreen('dashboard-screen');
  initDashboard();
});

// ── Session persistence ─────────────────────────────────
function saveSessionState() {
  localStorage.setItem('flow_active_session', JSON.stringify({
    sessionStart: sessionStart.toISOString(),
    currentTask,
    targetBlock,
    notes: sessionNotes.value,
  }));
}

function clearSessionState() {
  localStorage.removeItem('flow_active_session');
}

function restoreSessionIfAny() {
  try {
    const saved = localStorage.getItem('flow_active_session');
    if (!saved) return false;
    const s = JSON.parse(saved);
    if (!s.sessionStart || !s.currentTask) return false;

    sessionStart   = new Date(s.sessionStart);
    currentTask    = s.currentTask;
    sessionActive  = true;
    _restoredNotes = s.notes || '';

    // Validate the saved targetBlock against the current schedule — it may be
    // stale if the schedule was edited since the session was saved.
    const saved_tb = s.targetBlock;
    const stillInSchedule = saved_tb && schedule.some(
      b => b.time === saved_tb.time && b.label === saved_tb.label
    );
    targetBlock = stillInSchedule ? saved_tb : getNextBlock();

    // Recompute warning/transition flags from current time
    const remaining = targetBlock ? timeToMinutes(targetBlock.time) - getNow() : 999;
    warningFired    = remaining <= WARN_MINUTES;
    transitionFired = remaining <= 0;

    return true;
  } catch { return false; }
}

function applyRestoredSessionUI() {
  focusInput.disabled  = true;
  focusBtn.textContent = 'End session';
  focusBtn.classList.remove('btn-cta');
  focusBtn.classList.add('btn-ghost');
  if (warningFired && targetBlock) {
    focusHint.textContent = `${WARN_MINUTES} min until ${targetBlock.label} — start wrapping up`;
  } else {
    focusHint.textContent = '⌘↵ to end · use "Switch now" to trigger a transition';
  }
  switchNowBtn.disabled = false;
  if (ringSubLabel) ringSubLabel.textContent = 'elapsed';
  sessionTimer.classList.toggle('warning', warningFired);
  curTaskDisplay.textContent = currentTask;
  curTaskDisplay.classList.add('visible');
  document.body.classList.add('focus-mode');
  if (_restoredNotes) { sessionNotes.value = _restoredNotes; _restoredNotes = ''; }
  fetchReentryContext(currentTask);
}

// ── Dashboard init ─────────────────────────────────────
function initDashboard() {
  renderTodaySchedule();
  updateNextUp();
  startClock();
  loadSessionHistory();

  if (!dashboardInited) {
    dashboardInited = true;
    requestNotificationPermission();

    focusBtn.addEventListener('click', toggleSession);
    switchNowBtn.addEventListener('click', () => triggerTransition());
    sessionNotes.addEventListener('input', () => { if (sessionActive) saveSessionState(); });
    editScheduleBtn.addEventListener('click', () => {
      cancelEditBtn.style.display = sessionActive ? '' : 'none';
      // Repopulate form from current schedule so unsaved edits from a previous
      // cancelled edit don't linger and get accidentally saved.
      scheduleEntries.innerHTML = '';
      schedule.forEach(r => addScheduleRow(r.time, r.label));
      showScreen('setup-screen');
    });
    document.getElementById('weekly-btn').addEventListener('click', openWeekly);
    document.getElementById('weekly-close-btn').addEventListener('click', closeWeekly);
    document.getElementById('weekly-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeWeekly();
    });
  }

  if (restoreSessionIfAny()) {
    applyRestoredSessionUI();
    if (transitionFired) triggerTransition(targetBlock);
  }
}

// ── Browser notifications ───────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    updateNotifStatus();
    return;
  }
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  updateNotifStatus();
}

function updateNotifStatus() {
  if (!notifStatus) return;
  const perm = ('Notification' in window) ? Notification.permission : 'unavailable';
  notifStatus.classList.remove('granted', 'denied');
  if (perm === 'granted') {
    notifStatus.classList.add('granted');
    notifStatus.title = 'Notifications enabled';
  } else if (perm === 'denied') {
    notifStatus.classList.add('denied');
    notifStatus.title = 'Notifications blocked — enable in browser settings';
  } else {
    notifStatus.title = 'Notifications unavailable';
  }
}

function sendNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, silent: false });
  }
}

// ── Transition sound (Web Audio API) ───────────────────
function playChime(type = 'warn') {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = type === 'warn' ? [440, 554] : [528, 660, 784];
    let offset = 0;
    freqs.forEach(freq => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + offset);
      gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + offset + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.7);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.7);
      offset += 0.18;
    });
  } catch { /* audio not supported */ }
}

// ── Keyboard shortcuts ──────────────────────────────────
document.addEventListener('keydown', e => {
  // Cmd/Ctrl + Enter — toggle session
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (document.getElementById('dashboard-screen').classList.contains('active')) {
      toggleSession();
    }
  }
  // Esc — dismiss transition screen
  if (e.key === 'Escape') {
    if (document.getElementById('transition-screen').classList.contains('active')) {
      dismissTransition();
    }
    closeWeekly();
  }
});

// ── Weekly view ─────────────────────────────────────────
function openWeekly() {
  const modal = document.getElementById('weekly-modal');
  modal.classList.add('open');
  modal.removeAttribute('aria-hidden');
  fetchWeekly();
}

function closeWeekly() {
  const modal = document.getElementById('weekly-modal');
  // Move focus out before hiding so aria-hidden doesn't trap it
  document.getElementById('weekly-btn')?.focus();
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function fmtMins(m) {
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatWeekDay(dateStr) {
  const date  = new Date(dateStr + 'T12:00:00');
  const today = new Date();
  const yest  = new Date(today); yest.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yest.toDateString())  return 'Yesterday';
  return date.toLocaleDateString('en-GB', { weekday: 'long', month: 'short', day: 'numeric' });
}

async function fetchWeekly() {
  const el = document.getElementById('weekly-content');
  el.innerHTML = '<p class="weekly-loading">Loading...</p>';
  try {
    const res  = await fetch('/weekly');
    const data = await res.json();
    if (!data.days || !data.days.length) {
      el.innerHTML = '<p class="weekly-empty">No sessions this week yet.</p>';
      return;
    }
    el.innerHTML = data.days.map(day => `
      <div class="week-day">
        <div class="week-day-header">
          <span class="week-day-name">${formatWeekDay(day.date)}</span>
          <span class="week-day-total">${fmtMins(day.total_minutes)} total</span>
        </div>
        ${day.tasks.map(t => `
          <div class="week-task">
            <span class="week-task-name">${escapeHtml(t.task)}</span>
            <span class="week-task-mins">${fmtMins(t.minutes)}</span>
          </div>
        `).join('')}
      </div>
    `).join('');
  } catch {
    el.innerHTML = '<p class="weekly-empty">Could not load data — is the server running?</p>';
  }
}

// ── Session history from DB ─────────────────────────────
function formatLogDate(isoString) {
  const date  = new Date(isoString);
  const today = new Date();
  const time  = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return time;
  return date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' · ' + time;
}

async function loadSessionHistory() {
  try {
    const res  = await fetch('/history?limit=50');
    const data = await res.json();

    // Clear existing DB-loaded entries (keep in-memory items added this session)
    sessionLogEl.querySelectorAll('.log-item-history').forEach(el => el.remove());

    if (!data.sessions || !data.sessions.length) return;

    const empty = sessionLogEl.querySelector('.log-empty');
    if (empty) empty.remove();

    data.sessions.forEach(s => {
      const li = document.createElement('li');
      li.className = 'log-item log-item-history';
      li.innerHTML = `
        <div class="log-item-task">${escapeHtml(s.task_name)}</div>
        <div class="log-item-meta">${s.duration_minutes} min · ${formatLogDate(s.created_at)}</div>
      `;
      sessionLogEl.appendChild(li);
    });
  } catch {
    // DB might not be running — silently skip history
  }
}

function startClock() {
  if (clockInterval) clearInterval(clockInterval);
  tickClock();
  clockInterval = setInterval(tickClock, 1000);
}

function tickClock() {
  const now = new Date();
  if (liveClock) {
    liveClock.textContent = now.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }
  if (sessionActive) updateSessionTimer();
  updateNextUp();
  checkTransitionWarning();
}

// ── Session control ────────────────────────────────────
function toggleSession() {
  if (!sessionActive) {
    const task = focusInput.value.trim();
    if (!task) { focusInput.focus(); return; }
    startSession(task);
  } else {
    triggerTransition();
  }
}

function startSession(task) {
  currentTask     = task;
  sessionStart    = new Date();
  sessionActive   = true;
  warningFired    = false;
  transitionFired = false;
  _summaryCache   = null;

  targetBlock = getNextBlock();

  focusInput.disabled  = true;
  focusBtn.textContent = 'End session';
  focusBtn.classList.remove('btn-cta');
  focusBtn.classList.add('btn-ghost');
  focusHint.textContent = '⌘↵ to end · use "Switch now" to trigger a transition';
  switchNowBtn.disabled = false;
  if (ringSubLabel) ringSubLabel.textContent = 'elapsed';

  curTaskDisplay.textContent = task;
  curTaskDisplay.classList.add('visible');

  sessionNotes.value = '';

  document.body.classList.add('focus-mode');

  saveSessionState();
  fetchReentryContext(task);
}

async function fetchReentryContext(task) {
  try {
    const res  = await fetch(`/context?task=${encodeURIComponent(task)}`);
    const data = await res.json();
    if (data.context) {
      reentrySummary.textContent = data.context.summary;
      reentryCard.classList.add('visible');
    }
  } catch {
    // silently ignore — re-entry context is non-critical
  }
}

function endSession(log = true) {
  if (!sessionActive) return;

  if (log && currentTask) {
    const duration = Math.round((new Date() - sessionStart) / 60000);
    addLogItem(currentTask, duration);
  }

  sessionActive   = false;
  sessionStart    = null;
  currentTask     = '';
  warningFired    = false;
  transitionFired = false;
  targetBlock     = null;
  _summaryCache   = null;
  clearSessionState();

  focusInput.disabled   = false;
  focusInput.value      = '';
  focusBtn.textContent  = 'Start session';
  focusBtn.classList.remove('btn-ghost');
  focusBtn.classList.add('btn-cta');
  focusHint.textContent     = 'Name your task and press ⌘↵ or click Start';
  sessionTimer.textContent  = '00:00';
  if (ringSubLabel) ringSubLabel.textContent = 'ready';
  sessionTimer.className    = 'ring-timer';
  switchNowBtn.disabled     = true;

  curTaskDisplay.textContent = '';
  curTaskDisplay.classList.remove('visible');
  sessionNotes.value = '';
  reentryCard.classList.remove('visible');
  document.body.classList.remove('focus-mode');

  // Reset ring
  if (progressRingFill) progressRingFill.style.strokeDashoffset = RING_C;
}

function updateSessionTimer() {
  if (!sessionStart) return;
  const elapsed = Math.floor((new Date() - sessionStart) / 1000);
  const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  sessionTimer.textContent = `${m}:${s}`;
}

// ── Schedule helpers ───────────────────────────────────
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function getNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function getNextBlock() {
  const total = getNow();
  const future = schedule.filter(s => {
    if (timeToMinutes(s.time) <= total) return false;
    // Skip the block we're currently working on — handles early switches
    if (sessionActive && currentTask && s.label.toLowerCase() === currentTask.toLowerCase()) return false;
    return true;
  });
  return future.length ? future[0] : null;
}

function getCurrentBlock() {
  const total = getNow();
  const past  = schedule.filter(s => timeToMinutes(s.time) <= total);
  return past.length ? past[past.length - 1] : null;
}

// ── Next Up + progress ring update ────────────────────
function updateNextUp() {
  const next  = getNextBlock();
  const total = getNow();

  if (!next) {
    nextItemDisplay.innerHTML = `
      <div class="next-name">—</div>
      <div class="next-meta">No more blocks today</div>
    `;
    countdownWrap.style.display = 'none';
    return;
  }

  const nextMins  = timeToMinutes(next.time);
  const remaining = nextMins - total;

  nextItemDisplay.innerHTML = `
    <div class="next-name">${escapeHtml(next.label)}</div>
    <div class="next-meta">at ${escapeHtml(next.time)} &nbsp;·&nbsp; in ${remaining} min</div>
  `;

  countdownWrap.style.display = 'block';

  // Percentage of session time remaining
  const sessionStartMins = sessionActive
    ? sessionStart.getHours() * 60 + sessionStart.getMinutes()
    : total - 60;
  const totalMins = Math.max(nextMins - sessionStartMins, 1);
  const pct = Math.max(0, Math.min(100, (remaining / totalMins) * 100));

  // Bar
  progressFill.style.width = `${pct}%`;

  // Ring
  if (progressRingFill && sessionActive) {
    progressRingFill.style.strokeDashoffset = RING_C - (pct / 100) * RING_C;
  }

  // Labels + states
  countdownValue.textContent = fmtMins(remaining);

  const taskLabel = next.label.length > 18 ? next.label.slice(0, 17) + '…' : next.label;
  if (remaining <= 5) {
    countdownValue.className  = 'cd-value warning';
    progressFill.className    = 'bar-fill danger';
    countdownText.textContent = 'SWITCHING NOW';
  } else if (remaining <= WARN_MINUTES) {
    countdownValue.className  = 'cd-value warning';
    progressFill.className    = 'bar-fill warning';
    countdownText.textContent = `WRAPPING UP · ${taskLabel.toUpperCase()}`;
  } else {
    countdownValue.className  = 'cd-value';
    progressFill.className    = 'bar-fill';
    countdownText.textContent = `UNTIL · ${taskLabel.toUpperCase()}`;
  }
}

// ── Transition warning + auto-trigger ─────────────────
function checkTransitionWarning() {
  if (!sessionActive || !targetBlock) return;
  const remaining = timeToMinutes(targetBlock.time) - getNow();

  if (remaining <= WARN_MINUTES && !warningFired) {
    warningFired = true;
    sessionTimer.classList.add('warning');
    focusHint.textContent = `${WARN_MINUTES} min until ${targetBlock.label} — start wrapping up`;
    playChime('warn');
    sendNotification('Flow — Time to wrap up', `${targetBlock.label} starts in ${WARN_MINUTES} min.`);
  }

  if (remaining <= 0 && !transitionFired) {
    transitionFired = true;
    playChime('transition');
    sendNotification('Flow — Time to switch', `Starting ${targetBlock.label} now.`);
    triggerTransition(targetBlock);
  }
}

// ── Trigger transition screen ──────────────────────────
function triggerTransition(overrideNext = null) {
  // If the user is mid-edit on the setup screen, don't hijack it.
  // transitionFired stays true so initDashboard re-triggers this on return.
  if (document.getElementById('setup-screen').classList.contains('active')) return;

  const next     = overrideNext || getNextBlock() || { label: 'Next task' };
  const duration = sessionActive ? (Math.round((new Date() - sessionStart) / 60000) || 0) : 0;
  const task     = currentTask || 'Current task';
  const notes    = sessionNotes.value.trim();

  document.getElementById('t-from-task').textContent = task;
  document.getElementById('t-duration').textContent  = `${duration} min session`;
  document.getElementById('t-to-task').textContent   = next.label;
  document.getElementById('context-summary').textContent = 'Generating summary...';

  // Store transition data now. Summary starts as a fallback and gets updated
  // when the LLM responds. DB is only written when the user confirms.
  const fallback = `You worked on "${task}" for ${duration} min. Pick up here when you return.`;
  _pendingTransition = { task, duration, nextTask: next.label, notes, summary: fallback };

  showScreen('transition-screen');
  fetchTransitionSummary(task, duration, next.label, notes);
}

async function fetchTransitionSummary(task, duration, nextTask, notes = '') {
  // Use cached summary if inputs haven't changed
  if (
    _summaryCache &&
    _summaryCache.task    === task &&
    _summaryCache.nextTask === nextTask &&
    _summaryCache.notes   === notes
  ) {
    document.getElementById('context-summary').textContent = _summaryCache.summary;
    if (_pendingTransition) _pendingTransition.summary = _summaryCache.summary;
    return;
  }

  const reqId = ++_summaryReqId;
  try {
    const res = await fetch('/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_task: task, duration_minutes: duration, next_task: nextTask, notes })
    });
    if (reqId !== _summaryReqId) return; // a newer request is in flight — discard
    if (!res.ok) {
      const err = await res.text().catch(() => res.status);
      console.error('Summarize API error', res.status, err);
      // _pendingTransition.summary already holds the fallback text
      document.getElementById('context-summary').textContent = _pendingTransition?.summary ?? '';
      return;
    }
    const data = await res.json();
    const summary = data.summary || _pendingTransition?.summary || 'Session complete.';
    document.getElementById('context-summary').textContent = summary;
    if (_pendingTransition) _pendingTransition.summary = summary;
    // Cache result for reuse if inputs don't change
    _summaryCache = { task, nextTask, notes, summary };
  } catch (e) {
    if (reqId !== _summaryReqId) return;
    console.error('fetchTransitionSummary failed:', e);
    document.getElementById('context-summary').textContent = _pendingTransition?.summary ?? '';
  }
}

// ── Render timeline ────────────────────────────────────
function renderTodaySchedule() {
  todayScheduleEl.innerHTML = '';
  const total   = getNow();
  const current = getCurrentBlock();
  const last    = schedule.length - 1;

  schedule.forEach((block, i) => {
    const mins = timeToMinutes(block.time);
    const li   = document.createElement('li');
    li.className = 'tl-item';
    if (mins < total && block !== current) li.classList.add('past');
    if (block === current)                 li.classList.add('active');

    li.innerHTML = `
      <div class="tl-spine">
        <div class="tl-dot"></div>
        ${i < last ? '<div class="tl-line"></div>' : ''}
      </div>
      <div class="tl-body">
        <span class="tl-time">${escapeHtml(block.time)}</span>
        <span class="tl-name">${escapeHtml(block.label)}</span>
      </div>
    `;
    todayScheduleEl.appendChild(li);
  });
}

// ── Session log entry ──────────────────────────────────
function addLogItem(task, duration) {
  const empty = sessionLogEl.querySelector('.log-empty');
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = 'log-item';
  li.innerHTML = `
    <div class="log-item-task">${escapeHtml(task)}</div>
    <div class="log-item-meta">${duration} min · ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
  `;
  sessionLogEl.prepend(li);
  sessionLog.push({ task, duration });
}

// ── Dismiss transition (back-btn + Escape) ─────────────
function dismissTransition() {
  showScreen('dashboard-screen');
  _pendingTransition = null; // discard — no DB save

  let autoTransition = false;
  if (targetBlock) {
    const remaining = timeToMinutes(targetBlock.time) - getNow();
    if (remaining <= 0) {
      // Auto-transition: scheduled time has elapsed — advance so the clock
      // doesn't immediately re-trigger the same transition on the next tick.
      const idx = schedule.findIndex(b => b.time === targetBlock.time && b.label === targetBlock.label);
      targetBlock  = idx !== -1 ? (schedule[idx + 1] || null) : getNextBlock();
      autoTransition = true;
    }
    // If remaining > 0 the user hit "Switch now" early — keep targetBlock so
    // the scheduled auto-transition still fires at the correct time.
    saveSessionState();
  }
  transitionFired = false;
  // Reset warningFired only when we advanced to a new block (auto-transition).
  // For early manual dismissals, keep it true so the chime doesn't re-fire.
  if (autoTransition || !targetBlock) warningFired = false;
}

// ── Transition actions ─────────────────────────────────
document.getElementById('back-btn').addEventListener('click', dismissTransition);

document.getElementById('confirm-switch-btn').addEventListener('click', () => {
  const nextLabel = document.getElementById('t-to-task').textContent;

  // Save session to DB only now that the user has confirmed the switch.
  if (_pendingTransition) {
    const pt = _pendingTransition;
    fetch('/transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_task:     pt.task,
        duration_minutes: pt.duration,
        next_task:        pt.nextTask,
        notes:            pt.notes,
        summary:          pt.summary,
      })
    }).catch(e => console.error('Failed to save transition:', e));
    _pendingTransition = null;
  }

  endSession(true);
  showScreen('dashboard-screen');
  renderTodaySchedule();
  focusInput.value = nextLabel;
});

// ── Auto-restore on page load ───────────────────────────
(function autoRestore() {
  const savedSession  = localStorage.getItem('flow_active_session');
  const savedSchedule = loadScheduleFromStorage();
  if (!savedSession || !savedSchedule || !savedSchedule.length) return;

  // Populate schedule array directly, bypassing the setup form
  schedule = [...savedSchedule].sort((a, b) => a.time.localeCompare(b.time));

  // Skip setup screen — go straight to dashboard with session running
  showScreen('dashboard-screen');
  initDashboard();
})();
