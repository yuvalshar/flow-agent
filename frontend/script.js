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
let warningFired    = false;
let transitionFired = false;
let sessionLog      = [];
let clockInterval   = null;
let targetBlock     = null; // the next block at session-start; used for reliable transition detection

// ── DOM ────────────────────────────────────────────────
const scheduleEntries = document.getElementById('schedule-entries');
const addSlotBtn      = document.getElementById('add-slot-btn');
const startBtn        = document.getElementById('start-btn');

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
function addScheduleRow(time = '', label = '') {
  const row = document.createElement('div');
  row.className = 'schedule-row';
  row.innerHTML = `
    <input type="time" value="${escapeHtml(time)}">
    <input type="text" value="${escapeHtml(label)}" placeholder="e.g. Violin practice">
    <button class="remove-slot" title="Remove">×</button>
  `;
  row.querySelector('.remove-slot').addEventListener('click', () => row.remove());
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

addSlotBtn.addEventListener('click', () => addScheduleRow());

startBtn.addEventListener('click', () => {
  schedule = [];
  scheduleEntries.querySelectorAll('.schedule-row').forEach(row => {
    const time  = row.querySelector('input[type="time"]').value;
    const label = row.querySelector('input[type="text"]').value.trim();
    if (time && label) schedule.push({ time, label });
  });
  if (!schedule.length) return;
  schedule.sort((a, b) => a.time.localeCompare(b.time));
  saveScheduleToStorage(schedule);
  showScreen('dashboard-screen');
  initDashboard();
});

// ── Session persistence ─────────────────────────────────
function saveSessionState() {
  localStorage.setItem('flow_active_session', JSON.stringify({
    sessionStart: sessionStart.toISOString(),
    currentTask,
    targetBlock,
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

    sessionStart  = new Date(s.sessionStart);
    currentTask   = s.currentTask;
    targetBlock   = s.targetBlock || null;
    sessionActive = true;

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
  focusHint.textContent = '⌘↵ to end · use "Switch now" to trigger a transition';
  switchNowBtn.disabled = false;
  if (ringSubLabel) ringSubLabel.textContent = 'elapsed';
  if (warningFired)  sessionTimer.classList.add('warning');
  curTaskDisplay.textContent = currentTask;
  curTaskDisplay.classList.add('visible');
  document.body.classList.add('focus-mode');
  fetchReentryContext(currentTask);
}

// ── Dashboard init ─────────────────────────────────────
function initDashboard() {
  renderTodaySchedule();
  updateNextUp();
  startClock();
  loadSessionHistory();
  requestNotificationPermission();

  focusBtn.addEventListener('click', toggleSession);
  switchNowBtn.addEventListener('click', triggerTransition);
  editScheduleBtn.addEventListener('click', () => {
    endSession(false);
    showScreen('setup-screen');
  });
  document.getElementById('weekly-btn').addEventListener('click', openWeekly);
  document.getElementById('weekly-close-btn').addEventListener('click', closeWeekly);
  document.getElementById('weekly-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeWeekly();
  });

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
      showScreen('dashboard-screen');
      transitionFired = false;
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
    const res  = await fetch('/history');
    const data = await res.json();
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
  const future = schedule.filter(s => timeToMinutes(s.time) > total);
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
  const next     = overrideNext || getNextBlock() || { label: 'Next task' };
  const duration = sessionActive ? Math.round((new Date() - sessionStart) / 60000) : 0;
  const task     = currentTask || 'Current task';

  document.getElementById('t-from-task').textContent = task;
  document.getElementById('t-duration').textContent  = `${duration} min session`;
  document.getElementById('t-to-task').textContent   = next.label;
  document.getElementById('context-summary').textContent = 'Generating summary...';

  showScreen('transition-screen');
  const notes = sessionNotes.value.trim();
  generateContextSummary(task, duration, next.label, notes);
}

async function generateContextSummary(task, duration, nextTask, notes = '') {
  try {
    const res = await fetch('/transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_task: task, duration_minutes: duration, next_task: nextTask, notes })
    });
    const data = await res.json();
    document.getElementById('context-summary').textContent =
      data.summary || 'Session complete.';
  } catch {
    document.getElementById('context-summary').textContent =
      `You worked on "${task}" for ${duration} min. Pick up here when you return.`;
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

// ── Transition actions ─────────────────────────────────
document.getElementById('back-btn').addEventListener('click', () => {
  showScreen('dashboard-screen');
  transitionFired = false;
});

document.getElementById('confirm-switch-btn').addEventListener('click', () => {
  const nextLabel = document.getElementById('t-to-task').textContent;
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
