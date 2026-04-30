// PhysBall Arena — HTTP + Socket.IO server and authoritative game loop.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { Room } from './game.js';
import { WORLD, FIELD } from '../shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const app = express();
app.disable('x-powered-by');

// Serve the shared ES module so the browser can import the same constants.
app.use('/shared', express.static(path.join(ROOT, 'shared'), { extensions: ['js'] }));
app.use('/src', express.static(path.join(ROOT, 'client', 'src')));
app.use('/', express.static(path.join(ROOT, 'client', 'public')));

app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000,
});

const room = new Room('main');

io.on('connection', (socket) => {
  let joined = false;

  socket.on('join', (payload) => {
    if (joined) return;
    if (room.playerCount() >= WORLD.maxPlayersPerRoom) {
      socket.emit('join_rejected', { reason: 'room_full' });
      return;
    }
    const name = typeof payload?.name === 'string' ? payload.name : 'Player';
    const p = room.addPlayer(socket.id, name);
    joined = true;
    socket.emit('joined', {
      id: socket.id,
      team: p.team,
      name: p.name,
      field: { width: FIELD.width, height: FIELD.height },
      scoreToWin: WORLD.scoreToWin,
    });
    io.emit('player_joined', { id: socket.id, name: p.name, team: p.team });
  });

  socket.on('input', (input) => {
    if (!joined) return;
    room.setInput(socket.id, input);
  });

  socket.on('restart', () => {
    // Any connected player may request a restart once the match is over.
    if (room.phase === 'ended') room.restartMatch();
  });

  socket.on('disconnect', () => {
    if (joined) {
      room.removePlayer(socket.id);
      io.emit('player_left', { id: socket.id });
    }
  });
});

// Physics tick — fixed step, decoupled from broadcast rate.
const TICK_MS = 1000 / WORLD.tickHz;
const BROADCAST_MS = 1000 / WORLD.broadcastHz;

// Use a fixed-step integration (matches tickHz). This keeps the simulation
// deterministic and avoids the Matter.js "delta too large" warning when the
// event loop is momentarily delayed.
setInterval(() => {
  room.step(TICK_MS);
}, TICK_MS);

setInterval(() => {
  io.emit('state', room.snapshot());
}, BROADCAST_MS);

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`[physball] listening on http://0.0.0.0:${PORT}`);
});
