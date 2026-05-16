// ── Supabase Config ──────────────────────────────────────────────────────────
// Replace these with your own values from supabase.com → Project Settings → API
const SUPABASE_URL      = 'https://wtgdzqdntauluvvtunfd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qo01DgyYTMT856qOfCrv8w_WsC3WCCF';

// Game constants
const BET_COST = 5;       // $5 per bet
const BET_MAX  = 500;     // max guess value

// Cutoff time is loaded from app_settings (admin editable). Defaults below
// are used only until the first load completes.
let cutoffHour   = 11;
let cutoffMinute = 30;

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
  const email = $('loginEmail').value.trim();
  const pass  = $('loginPassword').value;
  if (!email || !pass) { setError('loginError', 'Please fill in all fields.'); return; }
  $('submitLogin').disabled = true;
  $('submitLogin').textContent = 'Logging in…';
  const { error } = await db.auth.signInWithPassword({ email, password: pass });
  $('submitLogin').disabled = false;
  $('submitLogin').textContent = 'Log In';
  if (error) { setError('loginError', error.message); return; }
  hide('loginModal');
});

$('submitRegister').addEventListener('click', async () => {
  clearError('registerError');
  const username = $('regUsername').value.trim();
  const email    = $('regEmail').value.trim();
  const pass     = $('regPassword').value;
  if (!username || !email || !pass) { setError('registerError', 'Please fill in all fields.'); return; }
  if (pass.length < 6) { setError('registerError', 'Password must be at least 6 characters.'); return; }
  if (!/^[a-zA-Z0-9_]{2,24}$/.test(username)) {
    setError('registerError', 'Username: 2-24 letters, numbers, or underscores.'); return;
  }
  $('submitRegister').disabled = true;
  $('submitRegister').textContent = 'Creating account…';
  const { data, error } = await db.auth.signUp({
    email, password: pass,
    options: { data: { username } }
  });
  $('submitRegister').disabled = false;
  $('submitRegister').textContent = 'Create Account';
  if (error) { setError('registerError', error.message); return; }
  hide('registerModal');
  if (!data.session) alert('Account created! Check your email to confirm, then log in.');
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
  if (h) cutoffHour   = parseInt(h.value, 10);
  if (m) cutoffMinute = parseInt(m.value, 10);
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
  return (Number(game.rollover_amount) || 0) + (game.bet_count || 0) * BET_COST;
}

// ── Keypad ───────────────────────────────────────────────────────────────────
let keypadValue = '';

function openKeypad() {
  if (!currentUser) { alert('Please log in first.'); return; }
  if (!isBettingOpen()) { alert('Betting is closed for today.'); return; }
  keypadValue = '';
  clearError('keypadError');
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
  if (/^[0-9]$/.test(e.key)) { handleDigit(e.key); e.preventDefault(); }
  else if (e.key === 'Backspace') { keypadValue = keypadValue.slice(0,-1); updateKeypadDisplay(); e.preventDefault(); }
  else if (e.key === 'Escape')  { hide('keypadModal'); }
  else if (e.key === 'Enter')   { if (!$('keypadOk').disabled) $('keypadOk').click(); }
});

$('keypadOk').addEventListener('click', async () => {
  clearError('keypadError');
  const val = parseInt(keypadValue, 10);
  if (isNaN(val) || val < 0 || val > BET_MAX) {
    setError('keypadError', `Pick a number from 0 to ${BET_MAX}.`); return;
  }
  if (!todayGame) { setError('keypadError', 'No active game yet. Refresh and try again.'); return; }
  if (!isBettingOpen()) { setError('keypadError', 'Betting closed.'); return; }

  $('keypadOk').disabled = true;
  $('keypadOk').textContent = 'Locking in…';
  const { error } = await db.from('bets').insert({
    user_id: currentUser.id,
    game_day_id: todayGame.id,
    predicted_count: val
  });
  $('keypadOk').textContent = '🔒 Lock In ($5)';
  $('keypadOk').disabled = false;

  if (error) {
    if (error.code === '23505') setError('keypadError', 'You already placed a bet today!');
    else setError('keypadError', error.message);
    return;
  }
  hide('keypadModal');
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

// ── Admin: bets management (paid toggle, delete) ─────────────────────────────
async function renderAdminBets() {
  if (!isAdmin || !todayGame) { return; }
  const { data: bets } = await db.from('bets')
    .select('*').eq('game_day_id', todayGame.id).order('created_at', { ascending: true });

  const tbody = $('adminBetsBody');
  tbody.innerHTML = '';
  $('paidSummary').textContent = '';

  if (!bets || bets.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No bets yet today.</td></tr>';
    return;
  }

  const userIds = [...new Set(bets.map(b => b.user_id))];
  const { data: profiles } = await db.from('profiles').select('id, username').in('id', userIds);
  const nameOf = id => profiles?.find(p => p.id === id)?.username || 'Unknown';

  const paidCount = bets.filter(b => b.paid).length;
  $('paidSummary').textContent = `${paidCount}/${bets.length} paid`;

  bets.forEach(b => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${nameOf(b.user_id)}</td>
      <td><strong>${b.predicted_count}</strong></td>
      <td>
        <label class="paid-toggle ${b.paid ? 'paid' : 'unpaid'}">
          <input type="checkbox" data-paid-bet="${b.id}" ${b.paid ? 'checked' : ''} />
          <span>${b.paid ? '✓ Paid' : 'Unpaid'}</span>
        </label>
      </td>
      <td><button class="btn-icon" data-delete-bet="${b.id}" title="Remove bet">🗑️</button></td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-paid-bet]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const betId = cb.dataset.paidBet;
      cb.disabled = true;
      const { error } = await db.from('bets').update({ paid: cb.checked }).eq('id', betId);
      cb.disabled = false;
      if (error) { alert('Error updating: ' + error.message); cb.checked = !cb.checked; return; }
      refreshUI();
    });
  });

  tbody.querySelectorAll('[data-delete-bet]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm("Remove this bet? They won't get a refund automatically — handle that with the player.")) return;
      btn.disabled = true;
      const { error } = await db.from('bets').delete().eq('id', btn.dataset.deleteBet);
      btn.disabled = false;
      if (error) { alert('Error deleting: ' + error.message); return; }
      refreshUI();
    });
  });
}

// ── Render UI ────────────────────────────────────────────────────────────────
async function refreshUI() {
  await loadSettings();
  $('todayDate').textContent = formatDate(todayDate());
  $('statCutoff').textContent = formatTime(cutoffHour, cutoffMinute);
  $('cutoffHourInput').value   = cutoffHour;
  $('cutoffMinuteInput').value = cutoffMinute;

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

  todayGame = await getOrCreateTodayGame();
  const jackpot = computeJackpot(todayGame);
  const betCount = todayGame?.bet_count || 0;
  const streak = await getStreakDaysNoWinner();

  $('statBetCount').textContent = betCount;
  $('statStreak').textContent = streak;
  $('jackpotAmount').textContent = `$${jackpot}`;
  $('jackpotSub').textContent = betCount === 0
    ? 'Be the first to bet and grow the pot!'
    : `${betCount} player${betCount !== 1 ? 's' : ''} in — pot keeps growing!`;

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
      paidEl.textContent = '✓ Payment received';
      paidEl.className = 'locked-payment paid';
    } else {
      paidEl.textContent = `💵 Pay $${BET_COST} to admin to confirm entry`;
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
    .select('game_date, actual_count, jackpot_amount, winner_user_id')
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
      <td>$${g.jackpot_amount}</td>`;
    tbody.appendChild(tr);
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

  const formCd   = $('formCountdown');
  const lockedCd = $('lockedCountdown');

  let text, urgent = false;
  if (ms <= 0) {
    text = '⏰ Betting closed — awaiting results';
  } else {
    const h = Math.floor(ms/3600000);
    const m = Math.floor((ms%3600000)/60000);
    const s = Math.floor((ms%60000)/1000);
    if (h > 0)       text = `⏰ ${h}h ${m}m left to bet (closes ${cutoffStr})`;
    else if (m > 0)  text = `⏰ ${m}m ${s}s left to bet (closes ${cutoffStr})`;
    else { text = `⏰ ${s}s left to bet!`; urgent = true; }
  }

  [formCd, lockedCd].forEach(el => {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('urgent', urgent);
  });

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
