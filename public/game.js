// ── WebSocket connection ───────────────────────────────
const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${protocol}//${location.host}/ws`;
let ws;
let myId = null;
let myName = '';
let myCards = [];
let room = null;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen    = () => console.log('WS connected');
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose   = () => {
    showToast('接続が切れました。再接続中…', 'mistake', 3000);
    setTimeout(connect, 2500);
  };
}

function send(type, data = {}) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type, ...data }));
}

// ── Audio ──────────────────────────────────────────────
let audioCtx;
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function beep(freq, dur, type = 'sine', vol = 0.25) {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = type; osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  osc.start(); osc.stop(ctx.currentTime + dur);
}
function sfxPlay()       { beep(523,.08); setTimeout(()=>beep(659,.12),90); }
function sfxMistake()    { beep(180,.4,'sawtooth',.4); }
function sfxStar()       { [523,659,784,1047].forEach((f,i)=>setTimeout(()=>beep(f,.1),i*70)); }
function sfxLevelClear() { [523,659,784,880,1047].forEach((f,i)=>setTimeout(()=>beep(f,.15),i*90)); }
function sfxGameOver()   { [300,250,200,150].forEach((f,i)=>setTimeout(()=>beep(f,.2,'square',.3),i*120)); }
function sfxVictory()    { [523,659,784,1047,1319,1568].forEach((f,i)=>setTimeout(()=>beep(f,.2),i*80)); }

// ── Screen ─────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Toast ──────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '', duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

// ── Overlay ────────────────────────────────────────────
function showOverlay({ icon, title, msg, showRestart, showLobby }) {
  document.getElementById('overlay-icon').textContent  = icon;
  document.getElementById('overlay-title').textContent = title;
  document.getElementById('overlay-msg').textContent   = msg;
  document.getElementById('btn-restart').classList.toggle('hidden', !showRestart);
  document.getElementById('btn-lobby').classList.toggle('hidden', !showLobby);
  document.getElementById('overlay').classList.remove('hidden');
}
function hideOverlay() { document.getElementById('overlay').classList.add('hidden'); }

// ── Lobby ──────────────────────────────────────────────
function renderLobby(r) {
  room = r;
  document.getElementById('lobby-code').textContent = r.code;
  document.getElementById('lobby-players').innerHTML = r.players.map(p => `
    <div class="player-row">
      <div class="player-avatar">${p.name.charAt(0).toUpperCase()}</div>
      <span class="player-name">${p.name}</span>
      ${p.id === r.host ? '<span class="player-badge">HOST</span>' : ''}
    </div>`).join('');
  const isHost = r.host === myId;
  document.getElementById('btn-start').classList.toggle('hidden', !isHost || r.players.length < 2);
  document.getElementById('lobby-wait').classList.toggle('hidden', isHost);
}

// ── Game ───────────────────────────────────────────────
function renderGame(r) {
  room = r;
  document.getElementById('g-round').textContent = r.round ?? 1;
  document.getElementById('g-lives').textContent = '❤️'.repeat(Math.max(0, r.lives)) || '－';
  document.getElementById('g-stars').textContent = r.stars > 0 ? '⭐'.repeat(r.stars) : '－';
  document.getElementById('btn-star').disabled = r.stars <= 0;
  const me = r.players.find(p => p.id === myId);
  document.getElementById('btn-banana').disabled = !me || me.bananas <= 0;

  const last = r.playedCards.length > 0 ? r.playedCards[r.playedCards.length - 1] : null;
  document.getElementById('pile-card').textContent = last ?? '－';

  document.getElementById('other-players').innerHTML = r.players
    .filter(p => p.id !== myId)
    .map(p => {
      const backs = Array.from({length: p.cardCount}, () => '<div class="card-back"></div>').join('');
      return `<div class="opp-row">
        <span class="opp-name">${p.name}</span>
        <div class="opp-cards">${backs || '<span style="color:var(--muted);font-size:0.8rem">手札なし</span>'}</div>
      </div>`;
    }).join('');
}

function renderHand(cards) {
  myCards = cards;
  const container = document.getElementById('hand-cards');
  const empty     = document.getElementById('hand-empty');
  if (!cards.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  container.innerHTML = cards.map(c =>
    `<div class="hand-card" data-card="${c}">${c}</div>`
  ).join('');
  container.querySelectorAll('.hand-card').forEach(el =>
    el.addEventListener('click', () => send('playCard', { card: +el.dataset.card }))
  );
}

function pileAnimate() {
  const el = document.getElementById('pile-card');
  el.classList.remove('played');
  void el.offsetWidth;
  el.classList.add('played');
}

function bodyShake() {
  document.body.classList.remove('flash-mistake');
  void document.body.offsetWidth;
  document.body.classList.add('flash-mistake');
}

// ── Message dispatch ───────────────────────────────────
function handle(d) {
  switch (d.type) {

    case 'connected':
      myId = d.id;
      break;

    case 'roomCreated':
      room = d.room;
      showScreen('screen-lobby');
      renderLobby(d.room);
      break;

    case 'joinedRoom':
      room = d.room;
      showScreen('screen-lobby');
      renderLobby(d.room);
      break;

    case 'playerJoined':
      renderLobby(d.room);
      showToast(`${d.name} が参加しました`);
      break;

    case 'playerLeft':
      if (d.room.status === 'waiting') renderLobby(d.room);
      else renderGame(d.room);
      showToast(`${d.name} が退出しました`);
      break;

    case 'backToLobby':
      myCards = [];
      hideOverlay();
      showScreen('screen-lobby');
      renderLobby(d.room);
      break;

    case 'gameStarted':
      hideOverlay();
      showScreen('screen-game');
      renderGame(d.room);
      showToast(`ラウンド 1 スタート！`, 'success', 1800);
      break;

    case 'yourCards':
      renderHand(d.cards);
      break;

    case 'cardPlayed':
      renderGame(d.room);
      pileAnimate();
      sfxPlay();
      if (d.playerName !== myName)
        showToast(`${d.playerName} が ${d.card} を出した`, '', 1800);
      break;

    case 'mistake':
      renderGame(d.room);
      bodyShake();
      sfxMistake();
      showToast(
        `💥 ${d.playerName} が ${d.wrongCard} でミス！ライフ残り ${d.room.lives}`,
        'mistake', 4000
      );
      break;

    case 'starUsed':
      renderGame(d.room);
      sfxStar();
      showToast(
        `⭐ ${d.usedBy} が手裏剣！ ${d.discarded.map(x=>`${x.playerName}:${x.card}`).join('、')}`,
        'star', 3500
      );
      break;

    case 'bananaUsed':
      renderGame(d.room);
      showToast(`🍌 ${d.fromName} と ${d.toName} がカード交換！`, 'star', 3000);
      break;

    case 'roundClear': {
      renderGame(d.room);
      sfxLevelClear();
      showOverlay({
        icon: '✨',
        title: `ラウンド ${d.round - 1} クリア！`,
        msg: `次はラウンド ${d.round}`,
        showRestart: false, showLobby: false,
      });
      setTimeout(hideOverlay, 2500);
      break;
    }

    case 'gameLost':
      renderGame(d.room);
      sfxGameOver();
      showOverlay({
        icon: '💀',
        title: 'ゲームオーバー',
        msg: `${d.playerName} が ${d.wrongCard} を出してミス…\nレベル ${d.room.level} で力尽きた`,
        showRestart: d.room.host === myId,
        showLobby: d.room.host === myId,
      });
      break;

    case 'error':
      showToast(`⚠️ ${d.message}`, 'mistake', 3000);
      break;
  }
}

// ── UI events ──────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', () => {
  const gameKey = document.getElementById('inp-key').value.trim().toUpperCase();
  const name    = document.getElementById('inp-name').value.trim();
  if (!gameKey) return showToast('ゲームキーを入力してください', 'mistake');
  if (!name)    return showToast('名前を入力してください', 'mistake');
  myName = name;
  send('createRoom', { name, gameKey });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const gameKey = document.getElementById('inp-key').value.trim().toUpperCase();
  const name    = document.getElementById('inp-name').value.trim();
  const code    = document.getElementById('inp-code').value.trim().toUpperCase();
  if (!gameKey)       return showToast('ゲームキーを入力してください', 'mistake');
  if (!name)          return showToast('名前を入力してください', 'mistake');
  if (code.length !== 4) return showToast('4文字のルームコードを入力してください', 'mistake');
  myName = name;
  send('joinRoom', { name, code, gameKey });
});

document.getElementById('inp-key').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('inp-name').focus();
});
document.getElementById('inp-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-create').click();
});
document.getElementById('inp-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

document.getElementById('btn-copy').addEventListener('click', () => {
  const code = document.getElementById('lobby-code').textContent;
  navigator.clipboard.writeText(code).then(() => showToast('コピーしました！', 'success', 1500));
});

document.getElementById('btn-start').addEventListener('click', () => send('startGame'));
document.getElementById('btn-star').addEventListener('click', () => {
  if (room?.stars > 0) send('useStar');
});
document.getElementById('btn-restart').addEventListener('click', () => {
  send('restartGame');
  hideOverlay();
});
document.getElementById('btn-lobby').addEventListener('click', () => send('returnToLobby'));

document.getElementById('btn-banana').addEventListener('click', () => {
  if (!room) return;
  const others = room.players.filter(p => p.id !== myId);
  const picker = document.getElementById('banana-picker');
  const targets = document.getElementById('banana-targets');
  targets.innerHTML = others.map(p =>
    `<button class="banana-target-btn" data-id="${p.id}">${p.name}</button>`
  ).join('');
  targets.querySelectorAll('.banana-target-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      send('useBanana', { targetId: btn.dataset.id });
      picker.classList.add('hidden');
    })
  );
  picker.classList.remove('hidden');
});

document.getElementById('btn-banana-cancel').addEventListener('click', () => {
  document.getElementById('banana-picker').classList.add('hidden');
});

// ── Start ──────────────────────────────────────────────
connect();
