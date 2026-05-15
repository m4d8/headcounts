// ── Supabase Config ──────────────────────────────────────────────────────────
// Replace these with your own values from supabase.com → Project Settings → API
const SUPABASE_URL      = 'https://wtgdzqdntauluvvtunfd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qo01DgyYTMT856qOfCrv8w_WsC3WCCF';

// Game settings
const BET_COST          = 1;    // virtual dollars added to pot per bet
const BET_CUTOFF_HOUR   = 11;   // 24h. Bets close at this hour:minute
const BET_CUTOFF_MINUTE = 30;

// Admin: the FIRST user to register becomes admin (set in DB trigger).
// You can also promote later via:
//   UPDATE profiles SET is_admin = true WHERE username = 'you';

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

let currentUser = null;
let currentProfile = null;
let isAdmin = false;
let todayGame = null;
let userBet = null;
let historyChart = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

function todayDate() {
  // Local-date YYYY-MM-DD (so "today" matches the user's wall clock)
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}

function isBettingOpen() {
  const now = new Date();
  return now.getHours() < BET_CUTOFF_HOUR ||
    (now.getHours() === BET_CUTOFF_HOUR && now.getMinutes() < BET_CUTOFF_MINUTE);
}

function setError(elId, msg) {
  const el = $(elId);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError(elId) { $(elId).classList.add('hidden'); }

// ── Auth UI wiring ───────────────────────────────────────────────────────────
$('btnLogin').addEventListener('click', () => { clearError('loginError'); show('loginModal'); });
$('btnRegister').addEventListener('click', () => { clearError('registerError'); show('registerModal'); });
$('btnLogout').addEventListener('click', async () => { await db.auth.signOut(); });
$('closeLogin').addEventListener('click', () => hide('loginModal'));
$('closeRegister').addEventListener('click', () => hide('registerModal'));
$('switchToRegister').addEventListener('click', e => { e.preventDefault(); hide('loginModal'); show('registerModal'); });
$('switchToLogin').addEventListener('click', e => { e.preventDefault(); hide('registerModal'); show('loginModal'); });
['loginModal','registerModal'].forEach(id => {
  $(id).addEventListener('click', e => { if (e.target === $(id)) hide(id); });
});

// Login
$('submitLogin').addEventListener('click', async () => {
  clearError('loginError');
  const email = $('loginEmail').value.trim();
  const pass  = $('loginPassword').value;
  if (!email || !pass) { setError('loginError', 'Please fill in all fields.'); return; }

  $('submitLogin').textContent = 'Logging in…';
  $('submitLogin').disabled = true;
  const { error } = await db.auth.signInWithPassword({ email, password: pass });
  $('submitLogin').textContent = 'Log In';
  $('submitLogin').disabled = false;

  if (error) { setError('loginError', error.message); return; }
  hide('loginModal');
});

// Register
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

  $('submitRegister').textContent = 'Creating account…';
  $('submitRegister').disabled = true;
  // Username is passed via metadata; the DB trigger creates the profile row.
  const { data, error } = await db.auth.signUp({
    email, password: pass,
    options: { data: { username } }
  });
  $('submitRegister').textContent = 'Create Account';
  $('submitRegister').disabled = false;

  if (error) { setError('registerError', error.message); return; }

  hide('registerModal');
  if (data.session) {
    // Email confirmation off — already logged in
    // refreshUI fires via onAuthStateChange
  } else {
    alert('Account created! Check your email to confirm, then log in.');
  }
});

// Auth state
db.auth.onAuthStateChange(async (_event, session) => {
  currentUser = session?.user ?? null;
  await refreshUI();
});

// ── Data layer ───────────────────────────────────────────────────────────────
async function getProfile(userId) {
  if (!userId) return null;
  const { data } = await db.from('profiles').select('*').eq('id', userId).maybeSingle();
  return data;
}

async function getRolloverFromPrevious() {
  // Rollover = (most-recent resolved game's final pot) if it had no winner, else 0
  const { data } = await db.from('game_days')
    .select('jackpot_amount, winner_user_id')
    .eq('is_resolved', true)
    .lt('game_date', todayDate())
    .order('game_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return 0;
  return data.winner_user_id ? 0 : (Number(data.jackpot_amount) || 0);
}

async function getOrCreateTodayGame() {
  const date = todayDate();

  // Try fetch
  let { data: game } = await db.from('game_days')
    .select('*').eq('game_date', date).maybeSingle();

  if (game) return game;

  // Need to create — only authenticated users can (RLS). Anon viewers just see $0.
  if (!currentUser) return null;

  const rollover = await getRolloverFromPrevious();
  const { data: inserted, error } = await db.from('game_days').insert({
    game_date: date,
    rollover_amount: rollover,
    bet_count: 0,
    jackpot_amount: 0,
    is_resolved: false
  }).select().maybeSingle();

  if (error) {
    // Possibly a race — re-fetch
    const { data: again } = await db.from('game_days')
      .select('*').eq('game_date', date).maybeSingle();
    return again;
  }
  return inserted;
}

async function getUserBet(gameDayId) {
  if (!currentUser || !gameDayId) return null;
  const { data } = await db.from('bets')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('game_day_id', gameDayId)
    .maybeSingle();
  return data;
}

async function getStreakDaysNoWinner() {
  const { data } = await db.from('game_days')
    .select('winner_user_id, game_date')
    .eq('is_resolved', true)
    .order('game_date', { ascending: false })
    .limit(30);
  if (!data || data.length === 0) return 0;
  let streak = 0;
  for (const g of data) {
    if (!g.winner_user_id) streak++;
    else break;
  }
  return streak;
}

function computeJackpot(game) {
  if (!game) return 0;
  return (Number(game.rollover_amount) || 0) + (game.bet_count || 0) * BET_COST;
}

// ── Place Bet ─────────────────────────────────────────────────────────────────
$('btnPlaceBet').addEventListener('click', async () => {
  const val = parseInt($('betInput').value, 10);
  if (isNaN(val) || val < 0 || val > 9999) {
    alert('Please enter a valid number (0–9999).'); return;
  }
  if (!todayGame) { alert('No active game yet — please refresh.'); return; }
  if (!isBettingOpen()) { alert('Betting has closed for today.'); return; }

  $('btnPlaceBet').textContent = 'Locking in…';
  $('btnPlaceBet').disabled = true;

  const { error } = await db.from('bets').insert({
    user_id: currentUser.id,
    game_day_id: todayGame.id,
    predicted_count: val
  });

  $('btnPlaceBet').textContent = '🔒 Lock It In';
  $('btnPlaceBet').disabled = false;

  if (error) {
    if (error.code === '23505') alert('You already placed a bet today!');
    else alert('Error placing bet: ' + error.message);
    return;
  }
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

  // Re-fetch latest game state for accurate bet_count
  const { data: fresh } = await db.from('game_days')
    .select('*').eq('id', todayGame.id).maybeSingle();
  const liveGame = fresh || todayGame;
  const jackpot = computeJackpot(liveGame);

  // Fetch all bets (admin RLS allows). Earliest correct guess wins the pot.
  const { data: bets } = await db.from('bets')
    .select('*')
    .eq('game_day_id', liveGame.id)
    .order('created_at', { ascending: true });

  const winner = (bets || []).find(b => b.predicted_count === actual) || null;

  const { error } = await db.from('game_days').update({
    is_resolved: true,
    actual_count: actual,
    jackpot_amount: jackpot,
    winner_user_id: winner ? winner.user_id : null
  }).eq('id', liveGame.id);

  $('btnResolve').disabled = false;

  if (error) {
    $('adminStatus').textContent = '❌ Error: ' + error.message;
    return;
  }

  // Look up winner username for status message
  let winnerName = '';
  if (winner) {
    const wp = await getProfile(winner.user_id);
    winnerName = wp?.username || 'Unknown';
  }

  $('adminStatus').textContent = winner
    ? `✅ Winner: ${winnerName}! Jackpot of $${jackpot} awarded.`
    : `❌ No winners. $${jackpot} rolls over to next game.`;

  await refreshUI();
});

// ── Render UI ────────────────────────────────────────────────────────────────
async function refreshUI() {
  $('todayDate').textContent = formatDate(todayDate());

  // Auth nav + profile
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

  // Today's game
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

  await renderHistory();
  await renderLeaderboard();
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
    show('betLoginPrompt');
    return;
  }

  if (!isBettingOpen()) {
    hide('betForm'); hide('betLocked'); hide('betLoginPrompt');
    show('betClosed');
    return;
  }

  userBet = await getUserBet(todayGame?.id);
  if (userBet) {
    hide('betForm'); hide('betClosed'); hide('betLoginPrompt');
    $('lockedNumber').textContent = userBet.predicted_count;
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

  // Resolve usernames in one query
  const userIds = [...new Set(bets.map(b => b.user_id))];
  const { data: profiles } = await db.from('profiles').select('id, username').in('id', userIds);
  const nameOf = id => profiles?.find(p => p.id === id)?.username || 'Unknown';

  show('betsSection');
  const tbody = $('betsBody');
  tbody.innerHTML = '';

  // Among exact-matchers, only the earliest gets the official winner badge,
  // but all exact-matchers get a "🎯 Exact" tag.
  const exactMatchers = bets.filter(b => b.predicted_count === game.actual_count);
  const officialWinnerId = game.winner_user_id;

  bets.forEach(b => {
    const isExact = b.predicted_count === game.actual_count;
    const isWinner = isExact && b.user_id === officialWinnerId;
    const tr = document.createElement('tr');
    let resultHtml;
    if (isWinner) {
      resultHtml = `<span class="tag-winner">🏆 Winner!</span>`;
    } else if (isExact) {
      resultHtml = `<span class="tag-winner">🎯 Exact (tied)</span>`;
    } else {
      const diff = Math.abs(b.predicted_count - game.actual_count);
      resultHtml = `<span class="tag-miss">Off by ${diff}</span>`;
    }
    tr.innerHTML = `<td>${nameOf(b.user_id)}</td><td><strong>${b.predicted_count}</strong></td><td>${resultHtml}</td>`;
    tbody.appendChild(tr);
  });
}

// ── History Chart & Table ────────────────────────────────────────────────────
async function renderHistory() {
  const { data: games } = await db.from('game_days')
    .select('game_date, actual_count, jackpot_amount, winner_user_id')
    .eq('is_resolved', true)
    .order('game_date', { ascending: false })
    .limit(30);

  if (!games || games.length === 0) {
    if (historyChart) { historyChart.destroy(); historyChart = null; }
    $('historyBody').innerHTML = '';
    return;
  }

  // Resolve usernames in one query
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
        { type: 'bar', label: 'Headcount', data: counts,
          backgroundColor: 'rgba(96,165,250,0.5)', borderColor: '#60a5fa',
          borderWidth: 1, yAxisID: 'y' },
        { type: 'line', label: 'Jackpot ($)', data: jackpots,
          borderColor: '#f5c518', backgroundColor: 'rgba(245,197,24,0.1)',
          borderWidth: 2, pointRadius: 4, pointBackgroundColor: '#f5c518',
          tension: 0.3, yAxisID: 'y2', fill: true }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#e8e8f0', font: { size: 12 } } } },
      scales: {
        x:  { ticks: { color: '#6b6b8a', font: { size: 11 } }, grid: { color: '#2a2a42' } },
        y:  { type: 'linear', position: 'left',
              title: { display: true, text: 'Headcount', color: '#60a5fa' },
              ticks: { color: '#6b6b8a' }, grid: { color: '#2a2a42' },
              beginAtZero: true },
        y2: { type: 'linear', position: 'right',
              title: { display: true, text: 'Jackpot ($)', color: '#f5c518' },
              ticks: { color: '#6b6b8a', callback: v => '$' + v },
              grid: { drawOnChartArea: false }, beginAtZero: true }
      }
    }
  });

  const tbody = $('historyBody');
  tbody.innerHTML = '';
  games.forEach(g => {
    const winnerName = g.winner_user_id ? nameOf(g.winner_user_id) : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(g.game_date)}</td>
      <td><strong>${g.actual_count}</strong></td>
      <td>${winnerName
        ? `<span class="tag-winner">🏆 ${winnerName}</span>`
        : `<span class="tag-miss">No winners</span>`}</td>
      <td>$${g.jackpot_amount}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Leaderboard ──────────────────────────────────────────────────────────────
async function renderLeaderboard() {
  const { data: games } = await db.from('game_days')
    .select('winner_user_id')
    .eq('is_resolved', true)
    .not('winner_user_id', 'is', null);

  if (!games || games.length === 0) {
    $('leaderboardList').innerHTML = '<p class="muted">No winners yet. Be the first!</p>';
    return;
  }

  // Count wins per user
  const counts = {};
  games.forEach(g => { counts[g.winner_user_id] = (counts[g.winner_user_id] || 0) + 1; });

  // Resolve usernames
  const ids = Object.keys(counts);
  const { data: profiles } = await db.from('profiles').select('id, username').in('id', ids);
  const sorted = Object.entries(counts)
    .map(([id, wins]) => ({
      name: profiles?.find(p => p.id === id)?.username || 'Unknown',
      wins
    }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 10);

  const rankSymbols = ['🥇','🥈','🥉'];
  const rankClasses = ['gold','silver','bronze'];
  const list = $('leaderboardList');
  list.innerHTML = '';
  sorted.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'leaderboard-item';
    div.innerHTML = `
      <div class="lb-rank ${rankClasses[i] || ''}">${rankSymbols[i] || i + 1}</div>
      <div class="lb-name">${row.name}</div>
      <div class="lb-wins">${row.wins}<span>win${row.wins !== 1 ? 's' : ''}</span></div>`;
    list.appendChild(div);
  });
}

// ── Realtime: refresh when bets / game_days change ───────────────────────────
db.channel('rt-bets')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'bets' }, refreshUI)
  .subscribe();
db.channel('rt-games')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'game_days' }, refreshUI)
  .subscribe();

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  const { data: { session } } = await db.auth.getSession();
  currentUser = session?.user ?? null;
  await refreshUI();
})();
