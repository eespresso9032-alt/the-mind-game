const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealCards(room) {
  const deck = shuffle(Array.from({ length: 100 }, (_, i) => i + 1));
  let idx = 0;
  room.players.forEach(p => {
    p.cards = deck.slice(idx, idx + room.level).sort((a, b) => a - b);
    idx += room.level;
  });
  room.playedCards = [];
}

function allCardsPlayed(room) {
  return room.players.every(p => p.cards.length === 0);
}

// Levels after which players gain a bonus (applied before new level starts)
const LIFE_BONUS = { 2: new Set([3,5,7]), 3: new Set([4,6,9]), 4: new Set([5,7,10]) };
const STAR_BONUS = { 2: new Set([2,5]),   3: new Set([3,6]),   4: new Set([4,8]) };

function publicRoom(room) {
  return {
    code: room.code,
    host: room.host,
    level: room.level,
    maxLevel: room.maxLevel,
    lives: room.lives,
    stars: room.stars,
    playedCards: room.playedCards,
    status: room.status,
    players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.cards.length })),
  };
}

function broadcast(room, event, data) {
  io.to(room.code).emit(event, { ...data, room: publicRoom(room) });
  room.players.forEach(p => io.to(p.id).emit('yourCards', { cards: p.cards }));
}

function advanceLevel(room) {
  if (room.level >= room.maxLevel) {
    room.status = 'won';
    io.to(room.code).emit('gameWon', { room: publicRoom(room) });
    return;
  }
  const nextLevel = room.level + 1;
  const n = room.players.length;
  const lifeBonus = LIFE_BONUS[n]?.has(nextLevel) ? 1 : 0;
  const starBonus = STAR_BONUS[n]?.has(nextLevel) ? 1 : 0;
  room.level = nextLevel;
  room.lives = Math.min(room.lives + lifeBonus, n + 3);
  room.stars += starBonus;
  dealCards(room);
  broadcast(room, 'levelClear', { lifeBonus, starBonus });
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name }) => {
    const code = generateCode();
    rooms[code] = {
      code, host: socket.id,
      players: [{ id: socket.id, name, cards: [] }],
      level: 1, maxLevel: 12,
      lives: 0, stars: 0,
      playedCards: [], status: 'waiting',
    };
    socket.join(code);
    socket.data = { roomCode: code, name };
    socket.emit('roomCreated', { code, room: publicRoom(rooms[code]) });
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room)                             return socket.emit('error', { message: 'ルームが見つかりません' });
    if (room.status !== 'waiting')         return socket.emit('error', { message: 'ゲームはすでに始まっています' });
    if (room.players.length >= 4)          return socket.emit('error', { message: 'ルームが満員です（最大4人）' });
    if (room.players.find(p => p.name === name)) return socket.emit('error', { message: '同じ名前のプレイヤーがいます' });

    room.players.push({ id: socket.id, name, cards: [] });
    socket.join(code.toUpperCase());
    socket.data = { roomCode: code.toUpperCase(), name };
    const pub = publicRoom(room);
    socket.emit('joinedRoom', { room: pub });
    socket.to(code.toUpperCase()).emit('playerJoined', { room: pub, name });
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data?.roomCode];
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 2) return socket.emit('error', { message: '2人以上でないと開始できません' });
    room.lives = room.players.length;
    room.stars = 1;
    room.level = 1;
    room.status = 'playing';
    dealCards(room);
    broadcast(room, 'gameStarted', {});
  });

  socket.on('playCard', ({ card }) => {
    const room = rooms[socket.data?.roomCode];
    if (!room || room.status !== 'playing') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.cards.includes(card)) return;

    // Any unplayed card across all players that is lower than this card?
    const lowerCards = room.players.flatMap(p =>
      p.id === socket.id
        ? p.cards.filter(c => c !== card && c < card)
        : p.cards.filter(c => c < card)
    );

    player.cards = player.cards.filter(c => c !== card);
    room.playedCards.push(card);

    if (lowerCards.length > 0) {
      room.lives--;
      // Discard all cards lower than the played card
      const discarded = [];
      room.players.forEach(p => {
        const lower = p.cards.filter(c => c < card);
        lower.forEach(c => { discarded.push({ playerId: p.id, playerName: p.name, card: c }); room.playedCards.push(c); });
        p.cards = p.cards.filter(c => c >= card);
      });

      if (room.lives <= 0) {
        room.status = 'lost';
        io.to(room.code).emit('gameLost', { room: publicRoom(room), wrongCard: card, playerName: player.name, discarded });
        room.players.forEach(p => io.to(p.id).emit('yourCards', { cards: p.cards }));
        return;
      }

      broadcast(room, 'mistake', { wrongCard: card, playerName: player.name, discarded });
      if (allCardsPlayed(room)) advanceLevel(room);
      return;
    }

    broadcast(room, 'cardPlayed', { card, playerName: player.name });
    if (allCardsPlayed(room)) advanceLevel(room);
  });

  socket.on('useStar', () => {
    const room = rooms[socket.data?.roomCode];
    if (!room || room.status !== 'playing' || room.stars <= 0) return;
    room.stars--;
    const discarded = [];
    room.players.forEach(p => {
      if (p.cards.length > 0) {
        const lowest = p.cards.shift();
        room.playedCards.push(lowest);
        discarded.push({ playerId: p.id, playerName: p.name, card: lowest });
      }
    });
    broadcast(room, 'starUsed', { discarded, usedBy: socket.data.name });
    if (allCardsPlayed(room)) advanceLevel(room);
  });

  socket.on('restartGame', () => {
    const room = rooms[socket.data?.roomCode];
    if (!room || room.host !== socket.id) return;
    if (!['won', 'lost'].includes(room.status)) return;
    room.lives = room.players.length;
    room.stars = 1;
    room.level = 1;
    room.status = 'playing';
    dealCards(room);
    broadcast(room, 'gameStarted', {});
  });

  socket.on('returnToLobby', () => {
    const room = rooms[socket.data?.roomCode];
    if (!room || room.host !== socket.id) return;
    room.status = 'waiting';
    room.players.forEach(p => { p.cards = []; });
    room.playedCards = [];
    io.to(room.code).emit('backToLobby', { room: publicRoom(room) });
  });

  socket.on('disconnect', () => {
    const { roomCode, name } = socket.data || {};
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) { delete rooms[roomCode]; return; }
    if (room.host === socket.id) room.host = room.players[0].id;
    io.to(roomCode).emit('playerLeft', { room: publicRoom(room), name });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`The Mind: http://localhost:${PORT}`));
