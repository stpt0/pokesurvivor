const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');

const MAX_PLAYERS = 4;
const MAX_MESSAGES_PER_SECOND = 90;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const HOST_RECONNECT_MS = 15000;

function originAllowed(origin, allowedOrigins) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

function createFirebaseVerifier() {
  const { getApps, initializeApp } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const app = getApps()[0] || initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'pokesurvivor-free' });
  return token => getAuth(app).verifyIdToken(token).then(decoded => decoded.uid);
}

function createCoopServer({ verifyToken = createFirebaseVerifier(), allowedOrigins = process.env.COOP_ALLOWED_ORIGINS || 'https://pokesurvivor.com,https://www.pokesurvivor.com,http://localhost:8000,http://127.0.0.1:8000', maxConnections = 256 } = {}) {
  const allowed = new Set(allowedOrigins.split(',').map(value => value.trim()).filter(Boolean));
  const rooms = new Map();
  const sessions = new Map();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: sessions.size }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
  let totalConnections = 0;

  function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      ws.terminate();
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  }

  function tellPresence(room, uid, online) {
    for (const [otherUid, client] of room.clients) {
      if (otherUid !== uid) send(client.ws, { k: 'presence', uid, online });
    }
  }

  function closeRoom(room) {
    if (rooms.get(room.id) !== room) return;
    rooms.delete(room.id);
    clearTimeout(room.hostTimer);
    for (const client of room.clients.values()) {
      client.room = null;
      send(client.ws, { k: 'room-closed' });
      client.ws.close(1000, 'Room closed');
    }
    room.clients.clear();
  }

  function detach(client, intentional = false) {
    const room = client.room;
    if (!room || room.clients.get(client.uid) !== client) return;
    room.clients.delete(client.uid);
    client.room = null;
    tellPresence(room, client.uid, false);
    if (client.uid === room.host) {
      if (intentional) closeRoom(room);
      else room.hostTimer = setTimeout(() => closeRoom(room), HOST_RECONNECT_MS);
    }
  }

  function join(client, input) {
    if (typeof input.room !== 'string' || input.room.length < 1 || input.room.length > 128) throw new Error('Phòng không hợp lệ.');
    const roomId = input.room;
    let room = rooms.get(roomId);
    if (!room) {
      if (client.uid !== roomId) throw new Error('Phòng chưa sẵn sàng.');
      room = { id: roomId, host: client.uid, allowed: new Set([client.uid]), clients: new Map(), hostTimer: 0 };
      rooms.set(roomId, room);
    }
    if (room.host !== roomId || !room.allowed.has(client.uid)) throw new Error('Bạn không thuộc phòng này.');
    if (room.clients.size >= MAX_PLAYERS && !room.clients.has(client.uid)) throw new Error('Phòng đã đầy.');
    clearTimeout(room.hostTimer);
    const replaced = room.clients.get(client.uid);
    if (replaced && replaced !== client) {
      replaced.room = null;
      replaced.ws.close(4001, 'Reconnected');
    }
    client.room = room;
    room.clients.set(client.uid, client);
    send(client.ws, { k: 'joined', uid: client.uid, host: room.host,
      peers: [...room.allowed].filter(uid => uid !== client.uid).map(uid => ({ uid, online: room.clients.has(uid) })) });
    tellPresence(room, client.uid, true);
  }

  function handle(client, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Mensaje inválido.');
    if (!client.uid) {
      if (message.k !== 'auth' || typeof message.token !== 'string' || typeof message.room !== 'string') throw new Error('Autenticación requerida.');
      return Promise.resolve(verifyToken(message.token)).then(uid => {
        if (typeof uid !== 'string' || !uid || uid.length > 128) throw new Error('Autenticación inválida.');
        client.uid = uid;
        const previous = sessions.get(uid);
        if (previous && previous !== client) detach(previous, false);
        sessions.set(uid, client);
        join(client, message);
      });
    }

    const room = client.room;
    if (!room || room.clients.get(client.uid) !== client) throw new Error('No estás conectado a una sala.');
    if (message.k === 'roster') {
      if (client.uid !== room.host || !Array.isArray(message.members)) throw new Error('Sólo el anfitrión puede actualizar el grupo.');
      const members = [...new Set(message.members.filter(uid => typeof uid === 'string' && uid.length > 0 && uid.length <= 128))];
      if (!members.includes(room.host) || members.length > MAX_PLAYERS) throw new Error('Grupo no válido.');
      room.allowed = new Set(members);
      for (const [uid, other] of room.clients) {
        if (!room.allowed.has(uid)) {
          room.clients.delete(uid);
          other.room = null;
          send(other.ws, { k: 'room-closed' });
          other.ws.close(1008, 'Removed from room');
        }
      }
      for (const uid of room.allowed) tellPresence(room, uid, room.clients.has(uid));
      return;
    }
    if (message.k === 'leave') {
      detach(client, client.uid === room.host);
      return;
    }
    if (message.k !== 'data' || typeof message.to !== 'string' || !room.allowed.has(message.to) ||
        (client.uid !== room.host && message.to !== room.host) || message.to === client.uid ||
        !message.msg || typeof message.msg !== 'object') {
      throw new Error('Mensaje inválido.');
    }
    const target = room.clients.get(message.to);
    if (target) send(target.ws, { k: 'data', from: client.uid, msg: message.msg });
  }

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/rooms' || !originAllowed(req.headers.origin, allowed) || totalConnections >= maxConnections) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      totalConnections++;
      wss.emit('connection', ws);
    });
  });

  wss.on('connection', ws => {
    const client = { uid: null, ws, room: null, windowAt: Date.now(), count: 0 };
    ws.on('message', (raw, binary) => {
      if (binary) { ws.close(1003, 'Text frames only'); return; }
      const now = Date.now();
      if (now - client.windowAt >= 1000) { client.windowAt = now; client.count = 0; }
      if (++client.count > MAX_MESSAGES_PER_SECOND) { ws.close(1008, 'Rate limit'); return; }
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { ws.close(1007, 'Invalid JSON'); return; }
      Promise.resolve().then(() => handle(client, message)).catch(error => {
        send(ws, { k: 'error', error: error.message });
      });
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      totalConnections = Math.max(0, totalConnections - 1);
      detach(client);
      if (client.uid && sessions.get(client.uid) === client) sessions.delete(client.uid);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);
  heartbeat.unref();
  wss.on('connection', ws => ws.on('pong', () => { ws.isAlive = true; }));
  server.on('close', () => { clearInterval(heartbeat); wss.close(); });

  return { server, close() {
    for (const room of rooms.values()) closeRoom(room);
    for (const ws of wss.clients) ws.terminate();
    return new Promise(resolve => server.close(resolve));
  } };
}

if (require.main === module) {
  const { server } = createCoopServer();
  const port = Number(process.env.PORT) || 8787;
  server.listen(port, '0.0.0.0', () => console.log(`Co-op server listening on ${port}`));
}

module.exports = { createCoopServer };