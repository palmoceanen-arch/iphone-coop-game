// Express + Socket.IO server for Twin Hearts.
//   - In dev (NODE_ENV !== 'production'): mounts Vite middleware so the game
//     and controller pages are served with HMR.
//   - In prod: serves the built `dist/` folder.
//   - Socket.IO manages "rooms" between a host (the desktop game page) and
//     up to two controllers (iPhone joypads). Inputs are forwarded host-bound.
import express from 'express';
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import { Server as IOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const HOST = process.env.HOST || '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';
// HTTPS is required for getUserMedia (camera) in iOS Safari over LAN.
// Enable via HTTPS=1 npm run dev — a self-signed cert is auto-generated
// on first start. Disable explicitly with HTTPS=0 if you only need HTTP.
const wantHttps = process.env.HTTPS === '1' || process.env.HTTPS === 'true';

function getLanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

async function ensureSelfSignedCert() {
  const dir = path.join(__dirname, 'certs');
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  }
  fs.mkdirSync(dir, { recursive: true });
  const selfsignedMod = await import('selfsigned');
  const selfsigned = selfsignedMod.default ?? selfsignedMod;
  const ips = getLanIps();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  // selfsigned >=3 returns a Promise.
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: ips[0] || 'localhost' }],
    { days: 825, keySize: 2048, extensions: [{ name: 'subjectAltName', altNames }] },
  );
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);
  console.log(`[https] Generated self-signed cert at ${dir}`);
  return { cert: pems.cert, key: pems.private };
}

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
    let code = '';
    do {
      code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
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
      const roomCode = String(code || '').replace(/\D/g, '').slice(0, 4);
      const room = rooms.get(roomCode);
      if (!room) { socket.emit('controller:rejected', { reason: 'no-room' }); return; }
      let slot = -1;
      if (!room.controllers[0]) slot = 0;
      else if (!room.controllers[1]) slot = 1;
      else { socket.emit('controller:rejected', { reason: 'full' }); return; }
      room.controllers[slot] = socket.id;
      socket.join(roomCode);
      socket.data.role = 'controller';
      socket.data.code = roomCode;
      socket.data.slot = slot;
      socket.emit('controller:assigned', { slot, code: roomCode });
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

    socket.on('host:to-slot', ({ slot, event, payload }) => {
      const code = socket.data.code;
      if (!code || socket.data.role !== 'host') return;
      const room = rooms.get(code);
      if (!room) return;
      const target = room.controllers[slot];
      if (target) io.to(target).emit(event, payload);
    });

    socket.on('host:broadcast', ({ event, payload }) => {
      const code = socket.data.code;
      if (!code || socket.data.role !== 'host') return;
      socket.to(code).emit(event, payload);
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
  // LAN host hint for the host page: returns the IP / port the iPhone should
  // connect to so the QR code can encode the right URL even when the host
  // page is opened on localhost. Uses HTTPS:HTTPS_PORT when HTTPS is enabled
  // so iOS Safari can grant camera permission.
  // -------------------------------------------------------------------------
  app.get('/api/lan-host', (_req, res) => {
    const ips = getLanIps();
    const ip = ips[0] || null;
    res.json({
      ip,
      ips,
      protocol: wantHttps ? 'https' : 'http',
      port: wantHttps ? HTTPS_PORT : PORT,
      httpPort: PORT,
      httpsPort: wantHttps ? HTTPS_PORT : null,
    });
  });

  // -------------------------------------------------------------------------
  // Static / Vite middleware
  // -------------------------------------------------------------------------
  app.get('/controller', (req, res) => {
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    res.redirect(307, `/controller.html${query}`);
  });

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

  if (wantHttps) {
    try {
      const certs = await ensureSelfSignedCert();
      const httpsServer = https.createServer(certs, app);
      // Attach the same Socket.IO instance so phones connected over HTTPS
      // talk to the same room map as the desktop host on HTTP.
      io.attach(httpsServer);
      httpsServer.listen(HTTPS_PORT, HOST, () => {
        const ips = getLanIps();
        const lan = ips[0] || HOST;
        console.log(`Twin Hearts HTTPS listening on https://${HOST}:${HTTPS_PORT}`);
        console.log(`  iPhone join URL: https://${lan}:${HTTPS_PORT}/controller`);
        console.log('  iOS will warn about the self-signed cert — tap "Show details" → "visit this website".');
      });
    } catch (err) {
      console.warn('[https] Failed to start HTTPS listener:', err?.message || err);
    }
  }
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
