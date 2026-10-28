/* ============ net.js — transporte cooperativo por WebSocket ============
 * El servidor central autentica cuentas Firebase y retransmite los frames.
 * La simulación sigue siendo host-authoritative dentro de coop.js.
 */
G.Net = (() => {
  const localHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const SERVER_URL = window.PS_COOP_SERVER_URL || (localHost ? 'ws://localhost:8787/rooms' : 'wss://coop.pokesurvivor.com/rooms');
  const RECONNECT_MIN = 1000, RECONNECT_MAX = 15000;
  const BUSY_BYTES = 64 * 1024;
  const handlers = new Set(), peerHandlers = new Set();
  const peerModes = new Map();
  const stats = { sent: 0, recv: 0, sentBytes: 0, recvBytes: 0, reconnects: 0 };
  let socket = null, roomId = null, uid = null, hostUid = null, isHost = false;
  let roster = [], reconnectTimer = 0, reconnectDelay = RECONNECT_MIN;
  let generation = 0, joined = false, intentionallyClosed = false;

  const sendWire = message => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch (e) { return false; }
  };

  function emitPeer(peer, state) {
    if (!peer || peer === uid || peerModes.get(peer) === state) return;
    peerModes.set(peer, state);
    peerHandlers.forEach(fn => { try { fn(peer, state); } catch (e) { console.warn(e); } });
  }

  function onMessage(event, current) {
    if (current !== socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch (e) { return; }
    if (!message || typeof message !== 'object') return;
    if (message.k === 'joined') {
      joined = true; reconnectDelay = RECONNECT_MIN;
      for (const peer of roster) if (peer !== uid) emitPeer(peer, 'connecting');
      for (const peer of message.peers || []) emitPeer(peer.uid, peer.online ? 'server' : 'failed');
      if (isHost) sendWire({ k: 'roster', members: roster });
      return;
    }
    if (message.k === 'presence') {
      emitPeer(message.uid, message.online ? 'server' : 'failed');
      return;
    }
    if (message.k === 'room-closed') {
      peerModes.forEach((state, peer) => emitPeer(peer, 'closed'));
      intentionallyClosed = true;
      joined = false;
      clearTimeout(reconnectTimer); reconnectTimer = 0;
      roomId = null;
      if (socket === current) { socket = null; current.close(1000, 'Room closed'); }
      handlers.forEach(fn => { try { fn(message.from || '', message); } catch (e) { console.error('[Net] mensaje:', e); } });
      return;
    }
    if (message.k === 'error') {
      console.warn('[Net] servidor:', message.error);
      if (!joined) current.close(4003, 'Room not ready');
      return;
    }
    if (message.k === 'data' && typeof message.from === 'string') {
      stats.recv++;
      stats.recvBytes += new TextEncoder().encode(event.data).byteLength;
      if (!peerModes.has(message.from)) emitPeer(message.from, 'server');
      handlers.forEach(fn => { try { fn(message.from, message.msg); } catch (e) { console.error('[Net] mensaje:', e); } });
    }
  }

  function connect(token, attempt) {
    if (!roomId || attempt !== generation) return;
    let ws;
    try { ws = new WebSocket(SERVER_URL); }
    catch (e) { scheduleReconnect(attempt); return; }
    socket = ws;
    ws.onopen = () => {
      if (attempt !== generation) { ws.close(); return; }
      ws.send(JSON.stringify({ k: 'auth', token, room: roomId }));
    };
    ws.onmessage = event => onMessage(event, ws);
    ws.onerror = () => {};
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null; joined = false;
      for (const peer of roster) if (peer !== uid) emitPeer(peer, 'failed');
      if (!intentionallyClosed && roomId && attempt === generation) scheduleReconnect(attempt);
    };
  }

  function scheduleReconnect(attempt) {
    if (reconnectTimer || !roomId || intentionallyClosed || attempt !== generation) return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = 0;
      if (!roomId || attempt !== generation || intentionallyClosed) return;
      try {
        const user = G.DB.fb.auth.currentUser;
        if (!user || user.isAnonymous) throw Error('Se necesita una cuenta para jugar en grupo.');
        const token = await user.getIdToken();
        stats.reconnects++;
        connect(token, attempt);
      } catch (e) {
        console.warn('[Net] no se pudo autenticar:', e.message);
        scheduleReconnect(attempt);
      }
    }, reconnectDelay);
    reconnectDelay = Math.min(RECONNECT_MAX, reconnectDelay * 2);
  }

  async function open(id, host, hostId) {
    if (roomId === id && socket) return;
    close();
    const fb = G.DB.fb, user = fb && fb.auth && fb.auth.currentUser;
    if (!fb || !user || user.isAnonymous) {
      console.warn('[Net] El co-op requiere una cuenta en la nube.');
      return;
    }
    roomId = id; uid = fb.uid; hostUid = hostId; isHost = !!host;
    intentionallyClosed = false; joined = false; reconnectDelay = RECONNECT_MIN;
    const attempt = ++generation;
    try { connect(await user.getIdToken(), attempt); }
    catch (e) { console.warn('[Net] no se pudo autenticar:', e.message); scheduleReconnect(attempt); }
  }

  function close() {
    intentionallyClosed = true;
    generation++;
    clearTimeout(reconnectTimer); reconnectTimer = 0;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) sendWire({ k: 'leave' });
      const old = socket; socket = null; old.close();
    }
    peerModes.forEach((state, peer) => emitPeer(peer, 'closed'));
    peerModes.clear();
    roomId = null; uid = null; hostUid = null; isHost = false; roster = []; joined = false;
  }

  function syncMembers(uids) {
    if (!roomId) return;
    roster = [...new Set(uids.filter(peer => typeof peer === 'string'))];
    for (const peer of [...peerModes.keys()]) if (!roster.includes(peer)) emitPeer(peer, 'closed');
    for (const peer of roster) if (peer !== uid && !peerModes.has(peer)) emitPeer(peer, 'connecting');
    if (joined && isHost) sendWire({ k: 'roster', members: roster });
  }

  function send(to, message) {
    if (!roomId || !message || typeof message !== 'object') return;
    stats.sent++;
    if (!sendWire({ k: 'data', to, msg: message })) return;
    stats.sentBytes += new TextEncoder().encode(JSON.stringify(message)).byteLength;
  }

  function toHost(message) { if (!isHost && hostUid) send(hostUid, message); }
  function broadcast(message, except) { for (const peer of roster) if (peer !== uid && peer !== except) send(peer, message); }

  return {
    open, close, syncMembers, send, toHost, broadcast,
    on(fn) { handlers.add(fn); }, off(fn) { handlers.delete(fn); },
    onPeer(fn) { peerHandlers.add(fn); },
    mode(peer) { return peerModes.get(peer) || (roomId ? 'connecting' : 'closed'); },
    viaTurn() { return false; },
    slow(peer) { return this.mode(peer) !== 'server'; },
    busy(peer) {
      return !!(roomId && (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > BUSY_BYTES ||
        (peer && peer !== uid && peerModes.get(peer) !== 'server')));
    },
    peers() { return [...peerModes.keys()].filter(peer => peerModes.get(peer) !== 'closed'); },
    get open_() { return !!roomId; },
    get isHost() { return isHost; },
    get uid() { return uid; },
    get hostUid() { return hostUid; },
    stats
  };
})();