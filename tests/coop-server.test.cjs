const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createCoopServer } = require('../server/coop-server');

let service, address;
before(async () => {
  service = createCoopServer({
    verifyToken: async token => ({ hostToken: 'host', guestToken: 'guest', outsiderToken: 'outsider' }[token]),
    allowedOrigins: 'http://localhost:8000'
  });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  address = `ws://127.0.0.1:${service.server.address().port}/rooms`;
});
after(async () => { await service.close(); });

function client(token, room) {
  const ws = new WebSocket(address, { origin: 'http://localhost:8000' });
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ k: 'auth', token, room }));
      resolve({ ws, messages });
    });
    ws.once('error', reject);
  });
}

function waitFor(client_, kind, predicate = () => true) {
  const existing = client_.messages.find(message => message.k === kind && predicate(message));
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${kind}`)), 1500);
    const check = data => {
      const message = JSON.parse(data.toString());
      if (message.k === kind && predicate(message)) {
        clearTimeout(timer);
        client_.ws.off('message', check);
        resolve(message);
      }
    };
    client_.ws.on('message', check);
  });
}

test('authenticated host roster authorizes guests and server relays with verified sender id', async t => {
  const host = await client('hostToken', 'host');
  const guest = await client('guestToken', 'host');
  t.after(() => { host.ws.terminate(); guest.ws.terminate(); });
  await Promise.all([waitFor(host, 'joined'), waitFor(guest, 'error')]);

  host.ws.send(JSON.stringify({ k: 'roster', members: ['host', 'guest'] }));
  const guestRetry = await client('guestToken', 'host');
  t.after(() => guestRetry.ws.terminate());
  await waitFor(guestRetry, 'joined');
  await waitFor(host, 'presence', message => message.uid === 'guest' && message.online);

  guestRetry.ws.send(JSON.stringify({ k: 'data', to: 'host', msg: { k: 'f', p: [1, 2] } }));
  const delivered = await waitFor(host, 'data');
  assert.equal(delivered.from, 'guest');
  assert.deepEqual(delivered.msg, { k: 'f', p: [1, 2] });
  guestRetry.ws.send(JSON.stringify({ k: 'data', to: 'outsider', msg: { k: 'start' } }));
  assert.match((await waitFor(guestRetry, 'error')).error, /inválido/);
});

test('non-host cannot change the room roster or relay to an unlisted identity', async t => {
  const host = await client('hostToken', 'host');
  t.after(() => host.ws.terminate());
  await waitFor(host, 'joined');
  host.ws.send(JSON.stringify({ k: 'roster', members: ['host', 'guest'] }));
  const guest = await client('guestToken', 'host');
  t.after(() => guest.ws.terminate());
  await waitFor(guest, 'joined');

  guest.ws.send(JSON.stringify({ k: 'roster', members: ['host', 'guest', 'outsider'] }));
  assert.match((await waitFor(guest, 'error')).error, /anfitrión/);
  guest.ws.send(JSON.stringify({ k: 'data', to: 'outsider', msg: { k: 'f' } }));
  assert.match((await waitFor(guest, 'error', message => /Mensaje inválido/.test(message.error))).error, /inválido/);
});

test('health endpoint exposes only temporary room and client counts', async () => {
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}/healthz`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.rooms, 'number');
  assert.equal(typeof health.clients, 'number');
});