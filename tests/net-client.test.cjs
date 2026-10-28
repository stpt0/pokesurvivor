const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../js/net/net.js'), 'utf8');

function client(hostname = 'localhost', serverUrl) {
  const sockets = [], timers = [];
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
  }
  const user = { isAnonymous: false, getIdToken: async () => 'firebase-token' };
  const G = { DB: { fb: { uid: 'host-uid', auth: { currentUser: user } } } };
  const setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  const browserWindow = { location: { hostname } };
  if (serverUrl) browserWindow.PS_COOP_SERVER_URL = serverUrl;
  new Function('G', 'window', 'WebSocket', 'setTimeout', 'clearTimeout', source)(G,
    browserWindow, Socket, setTimeout, () => {});
  return { N: G.Net, sockets, timers };
}

test('authenticates with Firebase and sends host roster through WebSocket', async () => {
  const { N, sockets } = client();
  await N.open('host-uid', true, 'host-uid');
  const ws = sockets[0];
  assert.equal(ws.url, 'ws://localhost:8787/rooms');
  assert.equal(N.busy(), true);
  ws.readyState = 1;
  ws.onopen();
  assert.equal(N.busy(), false);
  assert.deepEqual(ws.sent[0], { k: 'auth', token: 'firebase-token', room: 'host-uid' });
  N.syncMembers(['host-uid', 'guest-uid']);
  assert.equal(N.busy('guest-uid'), true);
  ws.receive({ k: 'joined', uid: 'host-uid', host: 'host-uid', peers: [] });
  assert.deepEqual(ws.sent.at(-1), { k: 'roster', members: ['host-uid', 'guest-uid'] });
  assert.equal(N.mode('guest-uid'), 'connecting');
  N.close();
});

test('production uses WSS and explicit local server URL overrides are respected', async () => {
  const production = client('pokesurvivor.com');
  await production.N.open('host-uid', true, 'host-uid');
  assert.equal(production.sockets[0].url, 'wss://coop.pokesurvivor.com/rooms');
  production.N.close();
  const custom = client('localhost', 'ws://127.0.0.1:9999/rooms');
  await custom.N.open('host-uid', true, 'host-uid');
  assert.equal(custom.sockets[0].url, 'ws://127.0.0.1:9999/rooms');
  custom.N.close();
});

test('forwards client frames and marks peers connected through the server', async () => {
  const { N, sockets } = client();
  const received = [], states = [];
  N.on((uid, message) => received.push([uid, message]));
  N.onPeer((uid, state) => states.push([uid, state]));
  await N.open('host-uid', true, 'host-uid');
  const ws = sockets[0]; ws.readyState = 1; ws.onopen();
  N.syncMembers(['host-uid', 'guest-uid']);
  ws.receive({ k: 'joined', uid: 'host-uid', peers: [{ uid: 'guest-uid', online: true }] });
  assert.equal(N.busy('guest-uid'), false);
  ws.receive({ k: 'presence', uid: 'guest-uid', online: false });
  assert.equal(N.busy('guest-uid'), true);
  ws.receive({ k: 'presence', uid: 'guest-uid', online: true });
  const frame = { k: 'f', t: 1, p: { guest: [1, 2] } };
  N.send('guest-uid', frame);
  assert.deepEqual(ws.sent.at(-1), { k: 'data', to: 'guest-uid', msg: frame });
  ws.receive({ k: 'data', from: 'guest-uid', msg: { k: 'f', p: [3, 4] } });
  assert.deepEqual(received, [['guest-uid', { k: 'f', p: [3, 4] }]]);
  assert.ok(states.some(([uid, state]) => uid === 'guest-uid' && state === 'server'));
  assert.equal(N.slow('guest-uid'), false);
  N.close();
});

test('connection loss schedules bounded reconnect without ending the room', async () => {
  const { N, sockets, timers } = client();
  await N.open('host-uid', true, 'host-uid');
  const ws = sockets[0]; ws.readyState = 1; ws.onopen();
  ws.close();
  assert.equal(N.open_, true);
  assert.equal(timers[0].delay, 1000);
  N.close();
});
