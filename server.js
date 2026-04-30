// Express + Socket.IO server for Twin Hearts.
//   - In dev (NODE_ENV !== 'production'): mounts Vite middleware so the game
//     and controller pages are served with HMR.
//   - In prod: serves the built `dist/` folder.
//   - Socket.IO manages "rooms" between a host (the desktop game page) and
//     up to two controllers (iPhone joypads). Inputs are forwarded host-bound.
import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';

async function main() {
  const app = express();
  const server = http.createServer(app);
  const io = new IOServer(server, { cors: { origin: '*' } });

  // -------------------------------------------------------------------------
  // Socket.IO room management
  // -------------------------------------------------------------------------
  /** @type {Map<string, { hostId: string, controllers: (string|null)[] }>} */
  const rooms = new Map();

  function genCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    } while (rooms.has(code));
    return code;
  }

  io.on('connection', (socket) => {
    socket.data = {};

    socket.on('host:create', () => {
      const code = genCode();
      rooms.set(code, { hostId: socket.id, controllers: [null, null] });
      socket.join(code);
      socket.data.role = 'host';
      socket.data.code = code;
      socket.emit('host:created', { code });
    });

    socket.on('controller:join', ({ code }) => {
      const upper = String(code || '').toUpperCase();
      const room = rooms.get(upper);
      if (!room) { socket.emit('controller:rejected', { reason: 'no-room' }); return; }
      let slot = -1;
      if (!room.controllers[0]) slot = 0;
      else if (!room.controllers[1]) slot = 1;
      else { socket.emit('controller:rejected', { reason: 'full' }); return; }
      room.controllers[slot] = socket.id;
      socket.join(upper);
      socket.data.role = 'controller';
      socket.data.code = upper;
      socket.data.slot = slot;
      socket.emit('controller:assigned', { slot, code: upper });
      io.to(room.hostId).emit('controller:joined', { slot });
    });

    socket.on('input:state', (state) => {
      const code = socket.data.code;
      const slot = socket.data.slot;
      if (typeof slot !== 'number' || !code) return;
      const room = rooms.get(code);
      if (!room) return;
      io.to(room.hostId).volatile.emit('input:state', { slot, state });
    });

    socket.on('input:event', (event) => {
      const code = socket.data.code;
      const slot = socket.data.slot;
      if (typeof slot !== 'number' || !code) return;
      const room = rooms.get(code);
      if (!room) return;
      io.to(room.hostId).emit('input:event', { slot, event });
    });

    socket.on('host:start', () => {
      const code = socket.data.code;
      if (!code) return;
      socket.to(code).emit('host:started');
    });

    socket.on('host:end', () => {
      const code = socket.data.code;
      if (!code) return;
      socket.to(code).emit('host:ended');
      rooms.delete(code);
    });

    socket.on('disconnect', () => {
      const code = socket.data.code;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;
      if (socket.data.role === 'host') {
        socket.to(code).emit('host:disconnected');
        rooms.delete(code);
      } else if (socket.data.role === 'controller') {
        const slot = socket.data.slot;
        if (typeof slot === 'number' && room.controllers[slot] === socket.id) {
          room.controllers[slot] = null;
          io.to(room.hostId).emit('controller:left', { slot });
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Static / Vite middleware
  // -------------------------------------------------------------------------
  if (isProd) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get(/^\/(?!socket\.io).*/, (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist/index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
      root: __dirname,
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, HOST, () => {
    console.log(`Twin Hearts server listening on http://${HOST}:${PORT}  (NODE_ENV=${isProd ? 'production' : 'development'})`);
  });
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
