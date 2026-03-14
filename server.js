const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 12;
const TOTAL_PAIRS = 20;

const FRUITS = [
  '🍎','🍊','🍋','🍇','🍓','🍒','🍑','🥭','🍍','🥝',
  '🍈','🍌','🍐','🫐','🍉','🥥','🍅','🫒','🥑','🍆'
];

let gameState = null;
let players = {};     // socketId -> { name, score, color, avatar, aaf }
let lobby = {};       // socketId -> { name }
let currentPlayerIndex = 0;
let flippedCards = [];
let lockBoard = false;
let gameStarted = false;
let playerOrder = [];

const PLAYER_COLORS = [
  '#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FECA57',
  '#FF9FF3','#54A0FF','#5F27CD','#00D2D3','#FF9F43',
  '#1DD1A1','#EE5A24'
];

const PLAYER_AVATARS = ['🐱','🐶','🐸','🦊','🐼','🦁','🐯','🐺','🦝','🐨','🦄','🐉'];

function createBoard() {
  const fruits = [...FRUITS, ...FRUITS];
  for (let i = fruits.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fruits[i], fruits[j]] = [fruits[j], fruits[i]];
  }
  return fruits.map((fruit, i) => ({
    id: i, fruit, flipped: false, matched: false, matchedBy: null
  }));
}

function getCurrentPlayer() {
  if (playerOrder.length === 0) return null;
  return playerOrder[currentPlayerIndex % playerOrder.length];
}

function nextTurn() {
  currentPlayerIndex = (currentPlayerIndex + 1) % playerOrder.length;
}

function checkGameOver() {
  return gameState && gameState.every(card => card.matched);
}

function getScoreboard() {
  return playerOrder.map(id => ({
    id,
    name: players[id]?.name || 'Bilinmeyen',
    score: players[id]?.score || 0,
    color: players[id]?.color,
    avatar: players[id]?.avatar
  })).sort((a, b) => b.score - a.score);
}

// Normal board (kartlar gizli)
function getBoardForNormal() {
  return gameState.map(card => ({
    id: card.id,
    fruit: (card.flipped || card.matched) ? card.fruit : null,
    flipped: card.flipped,
    matched: card.matched,
    matchedBy: card.matchedBy
  }));
}

// AAF board (tüm kartlar görünür - sadece o kişiye)
function getBoardForAAF() {
  return gameState.map(card => ({
    id: card.id,
    fruit: card.fruit,       // her zaman göster
    flipped: card.flipped,
    matched: card.matched,
    matchedBy: card.matchedBy,
    aafVisible: !card.flipped && !card.matched  // arka yüzde soluk göster
  }));
}

function broadcastGameState() {
  // Her oyuncuya ayrı ayrı gönder
  playerOrder.forEach(id => {
    const sock = io.sockets.sockets.get(id);
    if (!sock) return;
    const board = players[id]?.aaf ? getBoardForAAF() : getBoardForNormal();
    sock.emit('gameState', {
      board,
      currentPlayer: getCurrentPlayer(),
      scoreboard: getScoreboard(),
      playerOrder,
      locked: lockBoard
    });
  });
}

function broadcastLobby() {
  io.emit('lobbyUpdate', {
    players: Object.entries(lobby).map(([id, p]) => ({
      id,
      name: p.name,
      color: players[id]?.color,
      avatar: players[id]?.avatar
    })),
    maxPlayers: MAX_PLAYERS,
    gameStarted
  });
}

io.on('connection', (socket) => {
  console.log('Bağlantı:', socket.id);
  socket.emit('welcome', { id: socket.id, gameStarted });

  socket.on('joinLobby', ({ name, aaf }) => {
    if (gameStarted) {
      socket.emit('error', { message: 'Oyun devam ediyor, bitince katılabilirsiniz.' });
      return;
    }
    const count = Object.keys(lobby).length;
    if (count >= MAX_PLAYERS) {
      socket.emit('error', { message: 'Lobi dolu! Maksimum 12 oyuncu.' });
      return;
    }
    const colorIndex = count % PLAYER_COLORS.length;
    lobby[socket.id] = { name: name.slice(0, 16) };
    players[socket.id] = {
      name: name.slice(0, 16),
      score: 0,
      color: PLAYER_COLORS[colorIndex],
      avatar: PLAYER_AVATARS[colorIndex],
      aaf: aaf === true  // AAF modu flag
    };
    broadcastLobby();
    console.log(`${name} lobiye katıldı${aaf ? ' [AAF]' : ''}`);
  });

  socket.on('startGame', () => {
    const lobbyPlayers = Object.keys(lobby);
    if (lobbyPlayers.length < 2) {
      socket.emit('error', { message: 'En az 2 oyuncu gerekli!' });
      return;
    }
    if (socket.id !== lobbyPlayers[0]) {
      socket.emit('error', { message: 'Sadece host oyunu başlatabilir.' });
      return;
    }
    gameStarted = true;
    playerOrder = [...lobbyPlayers];
    playerOrder.forEach(id => { if (players[id]) players[id].score = 0; });
    currentPlayerIndex = 0;
    flippedCards = [];
    lockBoard = false;
    gameState = createBoard();

    // Her oyuncuya uygun board gönder
    playerOrder.forEach(id => {
      const sock = io.sockets.sockets.get(id);
      if (!sock) return;
      const board = players[id]?.aaf ? getBoardForAAF() : getBoardForNormal();
      sock.emit('gameStarted', {
        board,
        playerOrder,
        currentPlayer: getCurrentPlayer(),
        scoreboard: getScoreboard()
      });
    });
    console.log('Oyun başladı!', playerOrder.length, 'oyuncu');
  });

  socket.on('flipCard', ({ cardId }) => {
    if (!gameStarted || !gameState) return;
    if (lockBoard) return;
    if (socket.id !== getCurrentPlayer()) return;

    const card = gameState[cardId];
    if (!card || card.flipped || card.matched) return;
    if (flippedCards.find(c => c.id === cardId)) return;

    card.flipped = true;
    flippedCards.push(card);

    // Herkese kart çevrildiğini bildir (meyveyi göster)
    io.emit('cardFlipped', { cardId, fruit: card.fruit, playerId: socket.id });

    if (flippedCards.length === 2) {
      lockBoard = true;
      const [first, second] = flippedCards;

      if (first.fruit === second.fruit) {
        setTimeout(() => {
          first.matched = true; second.matched = true;
          first.matchedBy = socket.id; second.matchedBy = socket.id;
          players[socket.id].score += 10;
          flippedCards = [];
          lockBoard = false;

          io.emit('cardsMatched', {
            cardIds: [first.id, second.id],
            playerId: socket.id,
            playerName: players[socket.id]?.name,
            scoreboard: getScoreboard()
          });

          if (checkGameOver()) {
            const sb = getScoreboard();
            const winner = sb[0];
            io.emit('gameOver', { scoreboard: sb, winner });
            gameStarted = false;
            playerOrder = [];
            gameState = null;
            lobby = {};
            Object.keys(players).forEach(id => { if (players[id]) players[id].score = 0; });
          } else {
            broadcastGameState();
          }
        }, 600);
      } else {
        setTimeout(() => {
          first.flipped = false; second.flipped = false;
          flippedCards = [];
          lockBoard = false;
          nextTurn();

          io.emit('cardsMismatched', {
            cardIds: [first.id, second.id],
            nextPlayer: getCurrentPlayer()
          });

          broadcastGameState();
        }, 1200);
      }
    } else {
      broadcastGameState();
    }
  });

  // ── CHAT ──
  socket.on('chatMessage', ({ text }) => {
    const player = players[socket.id];
    if (!player) return;
    const clean = String(text).slice(0, 120).trim();
    if (!clean) return;
    io.emit('chatMessage', {
      playerId: socket.id,
      playerName: player.name,
      playerColor: player.color,
      playerAvatar: player.avatar || '🎮',
      text: clean,
      ts: Date.now()
    });
  });

  socket.on('playAgain', () => {
    gameStarted = false; gameState = null; playerOrder = [];
    flippedCards = []; lockBoard = false; currentPlayerIndex = 0;
    Object.keys(players).forEach(id => {
      if (players[id]) { players[id].score = 0; lobby[id] = { name: players[id].name }; }
    });
    io.emit('returnToLobby');
    broadcastLobby();
  });

  socket.on('disconnect', () => {
    console.log('Ayrıldı:', socket.id, players[socket.id]?.name);
    delete lobby[socket.id];
    delete players[socket.id];
    if (gameStarted && playerOrder.includes(socket.id)) {
      playerOrder = playerOrder.filter(id => id !== socket.id);
      if (playerOrder.length < 1) {
        gameStarted = false; gameState = null;
        io.emit('returnToLobby');
      } else {
        if (currentPlayerIndex >= playerOrder.length) currentPlayerIndex = 0;
        broadcastGameState();
      }
    }
    broadcastLobby();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🍎 Meyve Memory sunucusu çalışıyor: http://localhost:${PORT}`);
});
