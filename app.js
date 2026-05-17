// ── Supabase Config ──────────────────────────────────────────────────────────
// Replace these with your own values from supabase.com → Project Settings → API
const SUPABASE_URL      = 'https://wtgdzqdntauluvvtunfd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qo01DgyYTMT856qOfCrv8w_WsC3WCCF';

// Game constants
const BET_MAX  = 500;     // max guess value
const FAKE_EMAIL_DOMAIN = 'headcount.local';  // synthesized email for username-only auth

const usernameToFakeEmail = u => `${u.toLowerCase()}@${FAKE_EMAIL_DOMAIN}`;

// Runtime settings (loaded from app_settings; admin editable). Defaults below
// are used only until the first load completes.
let cutoffHour   = 11;
let cutoffMinute = 30;
let betCost      = 5;

// ── Init ─────────────────────────────────────────────────────────────────────
if (SUPABASE_URL.startsWith('YOUR_') || SUPABASE_ANON_KEY.startsWith('YOUR_')) {
  document.body.innerHTML =
    '<div style="padding:3rem;font-family:sans-serif;color:#f87171;text-align:center">' +
    '<h1>⚠️ Setup required</h1>' +
    '<p>Open <code>app.js</code> and replace <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> with your project values.</p>' +
    '<p>See <code>SETUP.md</code> for instructions.</p></div>';
  throw new Error('Supabase not configured');
}

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser    = null;
let currentProfile = null;
let isAdmin        = false;
let todayGame      = null;
let userBet        = null;
let historyChart   = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function formatDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}
function formatTime(h, m) {
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour12}:${String(m).padStart(2,'0')} ${period}`;
}
function msUntilCutoff() {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setHours(cutoffHour, cutoffMinute, 0, 0);
  return cutoff - now;
}
function isBettingOpen() { return msUntilCutoff() > 0; }

function setError(elId, msg) { const el=$(elId); el.textContent=msg; el.classList.remove('hidden'); }
function clearError(elId)    { $(elId).classList.add('hidden'); }

// ── Auth UI ──────────────────────────────────────────────────────────────────
$('btnLogin').addEventListener('click', () => { clearError('loginError'); show('loginModal'); });
$('btnRegister').addEventListener('click', () => { clearError('registerError'); show('registerModal'); });
$('btnLogout').addEventListener('click', async () => { await db.auth.signOut(); });
$('closeLogin').addEventListener('click', () => hide('loginModal'));
$('closeRegister').addEventListener('click', () => hide('registerModal'));
$('switchToRegister').addEventListener('click', e => { e.preventDefault(); hide('loginModal'); show('registerModal'); });
$('switchToLogin').addEventListener('click', e => { e.preventDefault(); hide('registerModal'); show('loginModal'); });
['loginModal','registerModal','keypadModal'].forEach(id => {
  $(id).addEventListener('click', e => { if (e.target === $(id)) hide(id); });
});

$('submitLogin').addEventListener('click', async () => {
  clearError('loginError');
  const username = $('loginUsername').value.trim();
  const pass     = $('loginPassword').value;
  if (!username || !pass) { setError('loginError', 'Please fill in all fields.'); return; }

  $('submitLogin').disabled = true;
  $('submitLogin').textContent = 'Logging in…';
  const { error } = await db.auth.signInWithPassword({
    email: usernameToFakeEmail(username),
    password: pass
  });
  $('submitLogin').disabled = false;
  $('submitLogin').textContent = 'Log In';

  if (error) {
    if (/invalid login/i.test(error.message)) {
      setError('loginError', 'Wrong username or password.');
    } else if (/email.*not.*confirmed/i.test(error.message)) {
      setError('loginError',
        'Email confirmation is still ON in Supabase. Go to Auth → Sign In / Providers → Email and turn off "Confirm email".');
    } else {
      setError('loginError', error.message);
    }
    return;
  }
  hide('loginModal');
});

$('submitRegister').addEventListener('click', async () => {
  clearError('registerError');
  const username = $('regUsername').value.trim();
  const pass     = $('regPassword').value;
  if (!username || !pass) { setError('registerError', 'Please fill in all fields.'); return; }
  if (pass.length < 6) { setError('registerError', 'Password must be at least 6 characters.'); return; }
  if (!/^[a-zA-Z0-9_]{2,24}$/.test(username)) {
    setError('registerError', 'Username: 2-24 letters, numbers, or underscores.'); return;
  }

  $('submitRegister').disabled = true;
  $('submitRegister').textContent = 'Creating account…';
  const { data, error } = await db.auth.signUp({
    email: usernameToFakeEmail(username),
    password: pass,
    options: { data: { username } }
  });
  $('submitRegister').disabled = false;
  $('submitRegister').textContent = 'Create Account';

  if (error) {
    if (/already registered|already exists|duplicate/i.test(error.message)) {
      setError('registerError', 'That username is already taken.');
    } else {
      setError('registerError', error.message);
    }
    return;
  }

  if (data.session) {
    hide('registerModal');
  } else {
    // Email confirmation is still on — synthetic emails can't be confirmed
    setError('registerError',
      '⚠️ Email confirmation is still enabled in Supabase. Username-only login needs it OFF: ' +
      'Supabase → Auth → Sign In / Providers → Email → turn off "Confirm email", then try again.');
  }
});

db.auth.onAuthStateChange(async (_event, session) => {
  currentUser = session?.user ?? null;
  await refreshUI();
});

// ── Data layer ───────────────────────────────────────────────────────────────
async function loadSettings() {
  const { data } = await db.from('app_settings').select('*');
  if (!data) return;
  const h = data.find(d => d.key === 'cutoff_hour');
  const m = data.find(d => d.key === 'cutoff_minute');
  const c = data.find(d => d.key === 'bet_cost');
  if (h) cutoffHour   = parseInt(h.value, 10);
  if (m) cutoffMinute = parseInt(m.value, 10);
  if (c) {
    const parsed = parseFloat(c.value);
    if (!isNaN(parsed) && parsed >= 0) betCost = parsed;
  }
}

async function getProfile(userId) {
  if (!userId) return null;
  const { data } = await db.from('profiles').select('*').eq('id', userId).maybeSingle();
  return data;
}

async function getRolloverFromPrevious() {
  const { data } = await db.from('game_days')
    .select('jackpot_amount, winner_user_id')
    .eq('is_resolved', true)
    .lt('game_date', todayDate())
    .order('game_date', { ascending: false })
    .limit(1).maybeSingle();
  if (!data) return 0;
  return data.winner_user_id ? 0 : (Number(data.jackpot_amount) || 0);
}

async function getOrCreateTodayGame() {
  const date = todayDate();
  let { data: game } = await db.from('game_days').select('*').eq('game_date', date).maybeSingle();
  if (game) return game;
  if (!currentUser) return null;

  const rollover = await getRolloverFromPrevious();
  const { data: inserted, error } = await db.from('game_days').insert({
    game_date: date, rollover_amount: rollover, bet_count: 0,
    jackpot_amount: 0, is_resolved: false
  }).select().maybeSingle();

  if (error) {
    const { data: again } = await db.from('game_days').select('*').eq('game_date', date).maybeSingle();
    return again;
  }
  return inserted;
}

async function getUserBet(gameDayId) {
  if (!currentUser || !gameDayId) return null;
  const { data } = await db.from('bets')
    .select('*').eq('user_id', currentUser.id).eq('game_day_id', gameDayId).maybeSingle();
  return data;
}

async function getStreakDaysNoWinner() {
  const { data } = await db.from('game_days')
    .select('winner_user_id').eq('is_resolved', true)
    .order('game_date', { ascending: false }).limit(30);
  if (!data) return 0;
  let s = 0;
  for (const g of data) { if (!g.winner_user_id) s++; else break; }
  return s;
}

function computeJackpot(game) {
  if (!game) return 0;
  // Only PAID bets contribute. Unpaid players are locked in but don't inflate the pot.
  return (Number(game.rollover_amount) || 0) + (game.paid_count || 0) * betCost;
}

// ── Keypad ───────────────────────────────────────────────────────────────────
let keypadValue = '';

function openKeypad() {
  if (!currentUser) { alert('Please log in first.'); return; }
  if (!isBettingOpen()) { alert('Betting is closed for today.'); return; }
  keypadValue = '';
  clearError('keypadError');
  clearError('confirmError');
  show('keypadPickView');
  hide('keypadConfirmView');
  updateKeypadDisplay();
  show('keypadModal');
}

function updateKeypadDisplay() {
  $('keypadDisplay').textContent = keypadValue === '' ? '—' : keypadValue;
  $('keypadOk').disabled = keypadValue === '';
}

function handleDigit(digit) {
  let next;
  if (keypadValue === '' || keypadValue === '0') next = digit;
  else next = keypadValue + digit;
  if (parseInt(next, 10) > BET_MAX) return;
  if (next.length > 3) return;
  keypadValue = next;
  updateKeypadDisplay();
}

document.querySelectorAll('[data-digit]').forEach(btn => {
  btn.addEventListener('click', () => handleDigit(btn.dataset.digit));
});
$('keypadBack').addEventListener('click', () => {
  keypadValue = keypadValue.slice(0, -1);
  updateKeypadDisplay();
});
$('keypadClear').addEventListener('click', () => {
  keypadValue = '';
  updateKeypadDisplay();
});
$('closeKeypad').addEventListener('click', () => hide('keypadModal'));
$('btnOpenKeypad').addEventListener('click', openKeypad);

// Keyboard support
document.addEventListener('keydown', e => {
  if ($('keypadModal').classList.contains('hidden')) return;
  const onConfirm = !$('keypadConfirmView').classList.contains('hidden');

  if (e.key === 'Escape') {
    if (onConfirm) { hide('keypadConfirmView'); show('keypadPickView'); }
    else hide('keypadModal');
    return;
  }
  if (e.key === 'Enter') {
    if (onConfirm) { if (!$('confirmLock').disabled) $('confirmLock').click(); }
    else if (!$('keypadOk').disabled) $('keypadOk').click();
    return;
  }

  // Digit/backspace only on the picker view
  if (onConfirm) return;
  if (/^[0-9]$/.test(e.key)) { handleDigit(e.key); e.preventDefault(); }
  else if (e.key === 'Backspace') { keypadValue = keypadValue.slice(0,-1); updateKeypadDisplay(); e.preventDefault(); }
});

// Step 1: OK → show confirmation view
$('keypadOk').addEventListener('click', () => {
  clearError('keypadError');
  const val = parseInt(keypadValue, 10);
  if (isNaN(val) || val < 0 || val > BET_MAX) {
    setError('keypadError', `Pick a number from 0 to ${BET_MAX}.`); return;
  }
  if (!todayGame) { setError('keypadError', 'No active game yet. Refresh and try again.'); return; }
  if (!isBettingOpen()) { setError('keypadError', 'Betting closed.'); return; }

  $('confirmNumber').textContent = val;
  $('confirmDate').textContent = formatDate(todayDate()) + "'s game";
  clearError('confirmError');
  hide('keypadPickView');
  show('keypadConfirmView');
  updateCountdownText(); // immediately populate the confirm countdown
});

// Cancel → back to keypad
$('confirmCancel').addEventListener('click', () => {
  hide('keypadConfirmView');
  show('keypadPickView');
});

// Step 2: Confirm → actually insert the bet
$('confirmLock').addEventListener('click', async () => {
  clearError('confirmError');
  const val = parseInt(keypadValue, 10);
  if (!isBettingOpen()) { setError('confirmError', 'Betting just closed.'); return; }

  $('confirmLock').disabled = true;
  $('confirmLock').textContent = 'Locking in…';
  const { error } = await db.from('bets').insert({
    user_id: currentUser.id,
    game_day_id: todayGame.id,
    predicted_count: val
  });
  $('confirmLock').disabled = false;
  $('confirmLock').textContent = '🔒 Confirm Bet';

  if (error) {
    if (error.code === '23505') setError('confirmError', 'You already placed a bet today!');
    else setError('confirmError', error.message);
    return;
  }
  hide('keypadModal');
  // Reset views so next open starts on the picker
  show('keypadPickView');
  hide('keypadConfirmView');
  await refreshUI();
});

// ── Admin: Cutoff settings ───────────────────────────────────────────────────
$('btnSaveCutoff').addEventListener('click', async () => {
  const h = parseInt($('cutoffHourInput').value, 10);
  const m = parseInt($('cutoffMinuteInput').value, 10);
  if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59) {
    $('settingsStatus').textContent = 'Invalid time.'; return;
  }
  $('settingsStatus').textContent = 'Saving…';
  const { error } = await db.from('app_settings').upsert([
    { key: 'cutoff_hour',   value: String(h) },
    { key: 'cutoff_minute', value: String(m) }
  ]);
  if (error) { $('settingsStatus').textContent = 'Error: ' + error.message; return; }
  cutoffHour = h; cutoffMinute = m;
  $('settingsStatus').textContent = `✅ Saved — cutoff now ${formatTime(h, m)}`;
  await refreshUI();
});

$('btnSaveBetCost').addEventListener('click', async () => {
  const c = parseFloat($('betCostInput').value);
  if (isNaN(c) || c < 0 || c > 999) {
    $('costStatus').textContent = 'Invalid cost (0–999).'; return;
  }
  // Warn if there are paid bets that would be retroactively repriced
  if (todayGame && (todayGame.paid_count || 0) > 0) {
    const pc = todayGame.paid_count;
    const ok = confirm(
      `Heads up: ${pc} paid bet${pc!==1?'s have':' has'} already been counted toward today's jackpot. ` +
      `Changing the price to $${c} will recalculate the pot for those paid bets. Continue?`
    );
    if (!ok) return;
  }
  $('costStatus').textContent = 'Saving…';
  const { error } = await db.from('app_settings').upsert([
    { key: 'bet_cost', value: String(c) }
  ]);
  if (error) { $('costStatus').textContent = 'Error: ' + error.message; return; }
  betCost = c;
  $('costStatus').textContent = `✅ Bet cost set to $${c}`;
  await refreshUI();
});

// ── Admin Resolve ────────────────────────────────────────────────────────────
$('btnResolve').addEventListener('click', async () => {
  const actual = parseInt($('adminCountInput').value, 10);
  if (isNaN(actual) || actual < 0 || actual > 9999) {
    alert('Please enter a valid headcount (0–9999).'); return;
  }
  if (!todayGame) { alert('No active game for today.'); return; }
  if (todayGame.is_resolved) { alert("Today's game is already resolved."); return; }

  $('adminStatus').textContent = 'Resolving…';
  $('btnResolve').disabled = true;

  const { data: fresh } = await db.from('game_days').select('*').eq('id', todayGame.id).maybeSingle();
  const liveGame = fresh || todayGame;
  const jackpot = computeJackpot(liveGame);

  const { data: bets } = await db.from('bets')
    .select('*').eq('game_day_id', liveGame.id).order('created_at', { ascending: true });
  const winner = (bets || []).find(b => b.predicted_count === actual) || null;

  const { error } = await db.from('game_days').update({
    is_resolved: true, actual_count: actual, jackpot_amount: jackpot,
    winner_user_id: winner ? winner.user_id : null
  }).eq('id', liveGame.id);
  $('btnResolve').disabled = false;

  if (error) { $('adminStatus').textContent = '❌ Error: ' + error.message; return; }

  let winnerName = '';
  if (winner) { const wp = await getProfile(winner.user_id); winnerName = wp?.username || 'Unknown'; }
  $('adminStatus').textContent = winner
    ? `✅ Winner: ${winnerName}! Jackpot of $${jackpot} awarded.`
    : `❌ No winners. $${jackpot} rolls over.`;

  await refreshUI();
});

// ── Admin: bets management (paid toggle w/ Save, delete) ─────────────────────
// Pending changes are held in memory until Save is pressed.
const pendingPaid = new Map(); // betId -> desired paid boolean

function updatePendingHint() {
  const n = pendingPaid.size;
  $('adminPendingHint').textContent = n === 0 ? '' : `${n} unsaved change${n !== 1 ? 's' : ''}`;
  $('btnSavePaid').disabled = n === 0;
}

async function renderAdminBets() {
  if (!isAdmin || !todayGame) { return; }
  const { data: bets } = await db.from('bets')
    .select('*').eq('game_day_id', todayGame.id).order('created_at', { ascending: true });

  const tbody = $('adminBetsBody');
  tbody.innerHTML = '';
  $('paidSummary').textContent = '';

  if (!bets || bets.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No bets yet today.</td></tr>';
    updatePendingHint();
    return;
  }

  // Drop pending entries for bets that no longer exist (e.g., deleted)
  const existingIds = new Set(bets.map(b => b.id));
  [...pendingPaid.keys()].forEach(id => { if (!existingIds.has(id)) pendingPaid.delete(id); });

  const userIds = [...new Set(bets.map(b => b.user_id))];
  const { data: profiles } = await db.from('profiles').select('id, username').in('id', userIds);
  const nameOf = id => profiles?.find(p => p.id === id)?.username || 'Unknown';

  // Effective paid status accounts for any pending change
  const effective = b => pendingPaid.has(b.id) ? pendingPaid.get(b.id) : !!b.paid;
  const paidCount = bets.filter(effective).length;
  $('paidSummary').textContent = `${paidCount}/${bets.length} paid`;

  bets.forEach(b => {
    const isPaid = effective(b);
    const isPending = pendingPaid.has(b.id);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${nameOf(b.user_id)}</td>
      <td><strong>${b.predicted_count}</strong></td>
      <td>
        <label class="paid-toggle ${isPaid ? 'paid' : 'unpaid'} ${isPending ? 'pending' : ''}">
          <input type="checkbox" data-paid-bet="${b.id}" ${isPaid ? 'checked' : ''} />
          <span>${isPaid ? '✓ Paid' : 'Unpaid'}</span>
        </label>
      </td>
      <td><button class="btn-icon" data-delete-bet="${b.id}" title="Remove bet">🗑️</button></td>`;
    tbody.appendChild(tr);
  });

  // Checkbox: stage change in pending map only — no DB write yet
  tbody.querySelectorAll('[data-paid-bet]').forEach(cb => {
    cb.addEventListener('change', () => {
      const betId = cb.dataset.paidBet;
      const current = bets.find(x => x.id === betId);
      const dbValue = !!current?.paid;
      if (cb.checked === dbValue) {
        pendingPaid.delete(betId);   // back to original — nothing to save
      } else {
        pendingPaid.set(betId, cb.checked);
      }
      // Re-render so styling (pending/paid/unpaid label) updates
      renderAdminBets();
    });
  });

  tbody.querySelectorAll('[data-delete-bet]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm("Remove this bet? They won't get a refund automatically — handle that with the player.")) return;
      btn.disabled = true;
      const { error } = await db.from('bets').delete().eq('id', btn.dataset.deleteBet);
      btn.disabled = false;
      if (error) { alert('Error deleting: ' + error.message); return; }
      pendingPaid.delete(btn.dataset.deleteBet);
      refreshUI();
    });
  });

  updatePendingHint();
}

// Save button: commit all pending paid changes
$('btnSavePaid').addEventListener('click', async () => {
  if (pendingPaid.size === 0) return;
  $('btnSavePaid').disabled = true;
  $('btnSavePaid').textContent = 'Saving…';
  $('paidStatus').textContent = '';

  const entries = [...pendingPaid.entries()];
  let failed = 0;
  for (const [betId, paid] of entries) {
    const { error } = await db.from('bets').update({ paid }).eq('id', betId);
    if (error) failed++;
    else pendingPaid.delete(betId);
  }

  $('btnSavePaid').textContent = 'Save';
  if (failed > 0) {
    $('paidStatus').textContent = `⚠️ ${failed} change${failed!==1?'s':''} failed to save.`;
  } else {
    $('paidStatus').textContent = `✅ Saved ${entries.length} change${entries.length!==1?'s':''}.`;
    setTimeout(() => { if ($('paidStatus')) $('paidStatus').textContent = ''; }, 3000);
  }
  await refreshUI();
});

// ── Render UI ────────────────────────────────────────────────────────────────
async function refreshUI() {
  await loadSettings();
  $('todayDate').textContent = formatDate(todayDate());
  $('statCutoff').textContent = formatTime(cutoffHour, cutoffMinute);
  $('cutoffHourInput').value   = cutoffHour;
  $('cutoffMinuteInput').value = cutoffMinute;
  $('betCostInput').value      = betCost;
  $('costInstruction').textContent = `$${betCost}`;
  $('costFineprint').textContent   = `$${betCost}`;

  if (currentUser) {
    hide('navAuth'); show('navUser');
    currentProfile = await getProfile(currentUser.id);
    isAdmin = !!currentProfile?.is_admin;
    $('userGreeting').textContent = `👋 ${currentProfile?.username || currentUser.email}`;
  } else {
    show('navAuth'); hide('navUser');
    currentProfile = null;
    isAdmin = false;
  }
  isAdmin ? show('adminPanel') : hide('adminPanel');
  document.body.classList.toggle('is-admin', isAdmin);

  todayGame = await getOrCreateTodayGame();
  const jackpot   = computeJackpot(todayGame);
  const betCount  = todayGame?.bet_count  || 0;
  const paidCount = todayGame?.paid_count || 0;
  const streak    = await getStreakDaysNoWinner();

  // "Players In" reflects paid players (the ones actually in the pot).
  // If unpaid bets are outstanding, append a hint so it's not confusing.
  $('statBetCount').textContent = paidCount;
  $('statStreak').textContent = streak;
  $('jackpotAmount').textContent = `$${jackpot}`;

  const unpaid = betCount - paidCount;
  if (paidCount === 0 && unpaid === 0) {
    $('jackpotSub').textContent = 'Be the first to bet and grow the pot!';
  } else if (paidCount === 0 && unpaid > 0) {
    $('jackpotSub').textContent = `${unpaid} bet${unpaid !== 1 ? 's' : ''} placed — pot grows once the pit boss confirms payment.`;
  } else {
    let txt = `${paidCount} player${paidCount !== 1 ? 's' : ''} paid in`;
    if (unpaid > 0) txt += ` (${unpaid} unpaid)`;
    txt += ' — pot keeps growing!';
    $('jackpotSub').textContent = txt;
  }

  if (todayGame?.is_resolved) {
    await renderResolvedState(todayGame, jackpot);
  } else {
    hide('resultBanner');
    await renderBetSection();
  }

  if (isAdmin) await renderAdminBets();

  await renderHistory();
  await renderLeaderboard();
  updateCountdownText();
}

async function renderResolvedState(game, jackpot) {
  const banner = $('resultBanner');
  banner.classList.remove('hidden', 'winner', 'no-winner');
  hide('betForm'); hide('betLocked'); hide('betClosed'); hide('betLoginPrompt');

  if (game.winner_user_id) {
    const wp = await getProfile(game.winner_user_id);
    const name = wp?.username || 'Unknown';
    banner.classList.add('winner');
    banner.innerHTML = `🏆 <strong>${name}</strong> nailed it at <strong>${game.actual_count}</strong> — won the <strong>$${jackpot}</strong> jackpot!`;
  } else {
    banner.classList.add('no-winner');
    banner.innerHTML = `❌ NO WINNERS on ${formatDate(game.game_date)} — actual count: <strong>${game.actual_count}</strong><br>JACKPOT IS NOW <strong>$${jackpot}</strong> (rolls over to next game)`;
  }
  await renderAllBets(game);
}

async function renderBetSection() {
  hide('resultBanner'); hide('betsSection');

  if (!currentUser) {
    hide('betForm'); hide('betLocked'); hide('betClosed');
    show('betLoginPrompt'); return;
  }
  if (!isBettingOpen()) {
    hide('betForm'); hide('betLocked'); hide('betLoginPrompt');
    show('betClosed'); return;
  }

  userBet = await getUserBet(todayGame?.id);
  if (userBet) {
    hide('betForm'); hide('betClosed'); hide('betLoginPrompt');
    $('lockedNumber').textContent = userBet.predicted_count;
    $('lockedDate').textContent = formatDate(todayDate());
    const paidEl = $('lockedPayment');
    if (userBet.paid) {
      paidEl.textContent = '✅ PAID';
      paidEl.className = 'locked-payment paid';
    } else {
      paidEl.textContent = `💵 Pay $${betCost} to the pit boss to confirm entry`;
      paidEl.className = 'locked-payment unpaid';
    }
    show('betLocked');
  } else {
    hide('betLocked'); hide('betClosed'); hide('betLoginPrompt');
    show('betForm');
  }
}

async function renderAllBets(game) {
  const { data: bets } = await db.from('bets')
    .select('predicted_count, user_id, created_at')
    .eq('game_day_id', game.id)
    .order('predicted_count', { ascending: true });

  if (!bets || bets.length === 0) { hide('betsSection'); return; }

  const userIds = [...new Set(bets.map(b => b.user_id))];
  const { data: profiles } = await db.from('profiles').select('id, username').in('id', userIds);
  const nameOf = id => profiles?.find(p => p.id === id)?.username || 'Unknown';

  show('betsSection');
  const tbody = $('betsBody');
  tbody.innerHTML = '';
  const officialWinnerId = game.winner_user_id;

  bets.forEach(b => {
    const isExact = b.predicted_count === game.actual_count;
    const isWinner = isExact && b.user_id === officialWinnerId;
    let html;
    if (isWinner) html = `<span class="tag-winner">🏆 Winner!</span>`;
    else if (isExact) html = `<span class="tag-winner">🎯 Exact (tied)</span>`;
    else {
      const diff = Math.abs(b.predicted_count - game.actual_count);
      html = `<span class="tag-miss">Off by ${diff}</span>`;
    }
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${nameOf(b.user_id)}</td><td><strong>${b.predicted_count}</strong></td><td>${html}</td>`;
    tbody.appendChild(tr);
  });
}

// ── History Chart & Table ────────────────────────────────────────────────────
async function renderHistory() {
  const { data: games } = await db.from('game_days')
    .select('id, game_date, actual_count, jackpot_amount, winner_user_id')
    .eq('is_resolved', true)
    .order('game_date', { ascending: false }).limit(30);

  if (!games || games.length === 0) {
    if (historyChart) { historyChart.destroy(); historyChart = null; }
    $('historyBody').innerHTML = ''; return;
  }

  const winnerIds = games.map(g => g.winner_user_id).filter(Boolean);
  let nameOf = () => null;
  if (winnerIds.length > 0) {
    const { data: profiles } = await db.from('profiles').select('id, username').in('id', winnerIds);
    nameOf = id => profiles?.find(p => p.id === id)?.username;
  }

  const reversed = [...games].reverse();
  const labels = reversed.map(g => formatDate(g.game_date).replace(/,.*/, ''));
  const counts = reversed.map(g => g.actual_count);
  const jackpots = reversed.map(g => Number(g.jackpot_amount) || 0);

  const ctx = $('historyChart').getContext('2d');
  if (historyChart) historyChart.destroy();
  historyChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type:'bar', label:'Headcount', data:counts,
          backgroundColor:'rgba(96,165,250,0.5)', borderColor:'#60a5fa',
          borderWidth:1, yAxisID:'y' },
        { type:'line', label:'Jackpot ($)', data:jackpots,
          borderColor:'#f5c518', backgroundColor:'rgba(245,197,24,0.1)',
          borderWidth:2, pointRadius:4, pointBackgroundColor:'#f5c518',
          tension:0.3, yAxisID:'y2', fill:true }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false },
      plugins:{ legend:{ labels:{ color:'#e8e8f0', font:{ size:12 } } } },
      scales:{
        x:{ ticks:{ color:'#6b6b8a', font:{ size:11 } }, grid:{ color:'#2a2a42' } },
        y:{ type:'linear', position:'left',
            title:{ display:true, text:'Headcount', color:'#60a5fa' },
            ticks:{ color:'#6b6b8a' }, grid:{ color:'#2a2a42' }, beginAtZero:true },
        y2:{ type:'linear', position:'right',
            title:{ display:true, text:'Jackpot ($)', color:'#f5c518' },
            ticks:{ color:'#6b6b8a', callback:v=>'$'+v },
            grid:{ drawOnChartArea:false }, beginAtZero:true }
      }
    }
  });

  const tbody = $('historyBody');
  tbody.innerHTML = '';
  games.forEach(g => {
    const wn = g.winner_user_id ? nameOf(g.winner_user_id) : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(g.game_date)}</td>
      <td><strong>${g.actual_count}</strong></td>
      <td>${wn ? `<span class="tag-winner">🏆 ${wn}</span>` : `<span class="tag-miss">No winners</span>`}</td>
      <td>$${g.jackpot_amount}</td>
      <td class="admin-only"><button class="btn-icon" data-delete-game="${g.id}" data-delete-date="${g.game_date}" title="Delete this game day">🗑️</button></td>`;
    tbody.appendChild(tr);
  });

  // Admin: delete a past game day
  tbody.querySelectorAll('[data-delete-game]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteGame;
      const dateStr = formatDate(btn.dataset.deleteDate);
      if (!confirm(
        `Delete ${dateStr}?\n\n` +
        `This permanently removes the game day AND all bets placed on it. ` +
        `Cannot be undone.`
      )) return;
      btn.disabled = true;
      const { error } = await db.from('game_days').delete().eq('id', id);
      btn.disabled = false;
      if (error) { alert('Error deleting: ' + error.message); return; }
      await refreshUI();
    });
  });
}

// ── Leaderboard ──────────────────────────────────────────────────────────────
async function renderLeaderboard() {
  const { data: games } = await db.from('game_days')
    .select('winner_user_id').eq('is_resolved', true)
    .not('winner_user_id', 'is', null);
  if (!games || games.length === 0) {
    $('leaderboardList').innerHTML = '<p class="muted">No winners yet. Be the first!</p>'; return;
  }
  const counts = {};
  games.forEach(g => { counts[g.winner_user_id] = (counts[g.winner_user_id]||0)+1; });
  const ids = Object.keys(counts);
  const { data: profiles } = await db.from('profiles').select('id, username').in('id', ids);
  const sorted = Object.entries(counts).map(([id,w]) => ({
    name: profiles?.find(p=>p.id===id)?.username || 'Unknown', wins:w
  })).sort((a,b)=>b.wins-a.wins).slice(0,10);

  const sym=['🥇','🥈','🥉'], cls=['gold','silver','bronze'];
  const list = $('leaderboardList'); list.innerHTML='';
  sorted.forEach((r,i)=>{
    const div=document.createElement('div'); div.className='leaderboard-item';
    div.innerHTML = `
      <div class="lb-rank ${cls[i]||''}">${sym[i]||i+1}</div>
      <div class="lb-name">${r.name}</div>
      <div class="lb-wins">${r.wins}<span>win${r.wins!==1?'s':''}</span></div>`;
    list.appendChild(div);
  });
}

// ── Countdown timer (runs every second) ──────────────────────────────────────
function updateCountdownText() {
  const ms = msUntilCutoff();
  const cutoffStr = formatTime(cutoffHour, cutoffMinute);

  const formCd    = $('formCountdown');
  const lockedCd  = $('lockedCountdown');
  const confirmCd = $('confirmCountdown');

  let text, confirmText, urgent = false;
  if (ms <= 0) {
    text = '⏰ Betting closed — awaiting results';
    confirmText = '⏰ Betting just closed!';
  } else {
    const h = Math.floor(ms/3600000);
    const m = Math.floor((ms%3600000)/60000);
    const s = Math.floor((ms%60000)/1000);
    if (h > 0)       { text = `⏰ ${h}h ${m}m left to bet (closes ${cutoffStr})`;
                       confirmText = `⏰ Game ends in ${h}h ${m}m (${cutoffStr})`; }
    else if (m > 0)  { text = `⏰ ${m}m ${s}s left to bet (closes ${cutoffStr})`;
                       confirmText = `⏰ Game ends in ${m}m ${s}s`; }
    else             { text = `⏰ ${s}s left to bet!`;
                       confirmText = `⏰ Only ${s}s left!`;
                       urgent = true; }
  }

  [formCd, lockedCd].forEach(el => {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('urgent', urgent);
  });
  if (confirmCd) {
    confirmCd.textContent = confirmText;
    confirmCd.classList.toggle('urgent', urgent);
  }

  // If we just crossed the cutoff while page was open, refresh UI to flip state
  if (ms <= 0 && !$('betForm').classList.contains('hidden')) refreshUI();
}
setInterval(updateCountdownText, 1000);

// ── Realtime ─────────────────────────────────────────────────────────────────
db.channel('rt-bets')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'bets' }, refreshUI)
  .subscribe();
db.channel('rt-games')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'game_days' }, refreshUI)
  .subscribe();
db.channel('rt-settings')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, async () => {
    await loadSettings();
    $('statCutoff').textContent = formatTime(cutoffHour, cutoffMinute);
    updateCountdownText();
  })
  .subscribe();

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  await loadSettings();
  const { data: { session } } = await db.auth.getSession();
  currentUser = session?.user ?? null;
  await refreshUI();
})();
