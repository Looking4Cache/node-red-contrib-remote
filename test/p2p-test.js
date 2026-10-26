// End-to-end test for the direct connection (WebRTC) of the remote-access node.
//
// Loads the real nodes with a minimal mock of the Node-RED runtime (RED object),
// starts a local "Node-RED dashboard" (HTTP + WebSocket echo) and acts as the
// Remote-RED app with werift: offer -> POST /contrib-remote/webrtc/offer/<hash>
// -> answer -> control + tcp-* DataChannels -> real HTTP request and WebSocket
// exchange through the DataChannels.
//
// Usage:
//   node test/p2p-test.js                 full test (werift installed)
//   node test/p2p-test.js --no-werift     simulates a missing werift, expects p2p_unavailable
//   node test/p2p-test.js --expect-unavailable   same check without simulation (werift really removed)
//   P2P_TEST_VERBOSE=1 node test/p2p-test.js   prints all node log lines
//
// No ssh process is started (REMOTERED_NO_SSH=1) and the Remote-RED API calls are mocked.
// The https case needs the openssl command line tool (self-signed certificate).

'use strict';

process.env.REMOTERED_NO_SSH = '1';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

const NO_WERIFT = process.argv.includes('--no-werift');
const EXPECT_UNAVAILABLE = NO_WERIFT || process.argv.includes('--expect-unavailable');
const VERBOSE = process.env.P2P_TEST_VERBOSE === '1';

if (NO_WERIFT) {
  // Make require('werift') fail like on a system where the optional dependency is missing
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function(request, ...args) {
    if (request === 'werift') {
      const error = new Error("Cannot find module 'werift'");
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return originalResolve.call(this, request, ...args);
  };
}

const express = require('express');
const { WebSocketServer } = require('ws');

const nodesDir = path.join(__dirname, '..', 'nodes');
const commons = require(path.join(nodesDir, 'remote-commons'));
const p2p = require(path.join(nodesDir, 'remote-p2p'));

// ---------------------------------------------------------------------------
// Helpers

let passed = 0;
function ok(text) {
  passed++;
  console.log(`  ok ${passed} - ${text}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeout(promise, ms, text) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout: ' + text)), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function waitFor(check, ms, text) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error('timeout waiting for: ' + text);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch (e) { json = undefined; }
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// ---------------------------------------------------------------------------
// Local "Node-RED dashboard": large HTTP response and WebSocket echo

const BIG_BODY = crypto.randomBytes(6 * 1024 * 1024 + 12345);
const BIG_HASH = sha256(BIG_BODY);
const dashboardState = { wsConnections: 0, wsClosed: 0, tcpConnections: 0 };

function startDashboard() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': BIG_BODY.length });
        res.end(BIG_BODY);
      } else if (req.url === '/hello') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 20 });
        res.end('hello from dashboard');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.on('connection', () => { dashboardState.tcpConnections++; });
    const wss = new WebSocketServer({ server: server, path: '/ws' });
    wss.on('connection', (ws) => {
      dashboardState.wsConnections++;
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
      ws.on('close', () => { dashboardState.wsClosed++; });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Mock of the Node-RED runtime

function createMockRED() {
  const types = {};
  const nodes = {};
  const app = express();
  const httpNode = express();
  app.use('/', httpNode);

  const RED = {
    nodes: {
      createNode: function(node, config) {
        node.id = config.id;
        node.name = config.name;
        node.credentials = config.credentials || {};
        node.handlers = {};
        node.logs = [];
        node.statuses = [];
        node.on = function(event, handler) { node.handlers[event] = handler; };
        const logger = (level) => (text) => {
          node.logs.push(`[${level}] ${text}`);
          if (VERBOSE || level === 'error') console.log(`    [${node.id}] [${level}] ${text}`);
        };
        node.log = logger('info');
        node.warn = logger('warn');
        node.error = logger('error');
        node.debug = logger('debug');
        node.status = function(status) { node.statuses.push(status); node.currentStatus = status; };
        node.send = function() {};
        nodes[config.id] = node;
      },
      registerType: function(name, constructor) { types[name] = constructor; },
      getNode: function(id) { return nodes[id]; }
    },
    httpNode: httpNode,
    httpAdmin: { get: function() {}, post: function() {} },
    auth: { needsPermission: function() { return function(req, res, next) { next(); }; } },
    settings: {},
    util: {
      generateId: function() { return crypto.randomBytes(8).toString('hex'); },
      evaluateNodeProperty: function(value) { return value; }
    },
    _: function(key, options) {
      const catalog = {
        'remote-access.status.serving': 'serving',
        'remote-access.status.direct': '__count__ direct'
      };
      let text = catalog[key] || key;
      if (options) {
        Object.keys(options).forEach((k) => { text = text.replace(`__${k}__`, options[k]); });
      }
      return text;
    },
    types: types,
    app: app
  };
  return RED;
}

// Mocked Remote-RED API (instanceSlotRequest + heartbeat), configurable per instancehash
const apiState = { p2pByInstance: {}, heartbeats: [] };
commons.createAxiosInstance = function() {
  return {
    post: async function(url, data) {
      if (url.endsWith('/instanceSlotRequest')) {
        const response = { port: 40000 };
        const p2pConfig = apiState.p2pByInstance[data.instancehash];
        if (p2pConfig !== undefined) response.p2p = p2pConfig;
        return { data: response };
      }
      if (url.endsWith('/heartbeat')) {
        apiState.heartbeats.push(data);
        return { data: { status: 'OK' } };
      }
      throw new Error('unexpected api call ' + url);
    }
  };
};

// Capture the heartbeat interval so the test can trigger a heartbeat directly
const heartbeatCalls = {};
const originalSetInterval = global.setInterval;
global.setInterval = function(fn, delay, ...args) {
  if (delay === 5 * 60 * 1000 && args[0] && args[0].id) {
    heartbeatCalls[args[0].id] = () => fn(...args);
  }
  return originalSetInterval(fn, delay, ...args);
};

function createInstance(RED, id, instancehash, dashboardPort, extraConfig) {
  const ConfigNode = RED.types['remote-config'];
  const AccessNode = RED.types['remote-access'];
  const configCfg = Object.assign({
    id: 'cfg-' + id,
    name: 'Test ' + id,
    host: 'localhost',
    protocol: 'http',
    port: dashboardPort,
    baseurl: '/',
    instancehash: instancehash,
    server: 'dev.test',
    region: 'de',
    credentials: { instanceauth: 'auth-' + id }
  }, extraConfig || {});
  const config = new ConfigNode(configCfg);
  const access = new AccessNode({ id: 'acc-' + id, name: 'Access ' + id, confignode: configCfg.id, verbose: true });
  return { config: config, access: access, url: `/contrib-remote/webrtc/offer/${instancehash}` };
}

function closeNode(node) {
  return new Promise((resolve) => node.handlers.close(false, resolve));
}

function routeExists(RED, url) {
  return RED.httpNode._router.stack.some((layer) => layer.route && layer.route.path === url);
}

// ---------------------------------------------------------------------------
// Simulated app (werift as offerer)

async function createAppPeer(werift) {
  const pc = new werift.RTCPeerConnection({ iceServers: [] });
  const control = pc.createDataChannel('control', { ordered: true });
  const offer = await pc.createOffer();
  // Same werift quirk handling as the node: no Google STUN fallback, bounded gathering
  p2p._prepareIceTransports(pc, []);
  await pc.setLocalDescription(offer);
  return { pc: pc, control: control, sdp: pc.localDescription.sdp };
}

async function connectApp(werift, port, url) {
  const app = await createAppPeer(werift);
  const start = Date.now();
  const response = await postJson(port, url, { sdp: app.sdp, client: 'ios', version: 'test' });
  app.answerMs = Date.now() - start;
  app.response = response;
  if (response.status !== 200) return app;
  const controlOpen = new Promise((resolve) => {
    if (app.control.readyState === 'open') resolve();
    app.control.addEventListener('open', resolve);
  });
  await app.pc.setRemoteDescription({ type: 'answer', sdp: response.json.sdp });
  await timeout(controlOpen, 10000, 'control channel open');
  app.connectMs = Date.now() - start;
  return app;
}

function openChannel(app, label) {
  // werift as app reuses a stream id as soon as its side of the channel is closed, before
  // the SCTP stream reset finished in both directions. The new channel then never opens on
  // the other side. libwebrtc (the real apps) only releases ids after the reset completed.
  // The simulated app therefore never reuses ids (same parity as werift would use).
  if (app.nextStreamId === undefined) app.nextStreamId = app.control.id + 2;
  const channel = app.pc.createDataChannel(label, { ordered: true, id: app.nextStreamId });
  app.nextStreamId += 2;
  const state = { channel: channel, received: [], receivedBytes: 0, closed: false };
  channel.addEventListener('message', (event) => {
    const data = typeof event.data === 'string' ? Buffer.from(event.data) : event.data;
    state.received.push(data);
    state.receivedBytes += data.length;
    if (state.onData) state.onData();
  });
  channel.addEventListener('close', () => { state.closed = true; if (state.onData) state.onData(); });
  state.opened = new Promise((resolve) => {
    if (channel.readyState === 'open') resolve();
    channel.addEventListener('open', resolve);
  });
  state.send = (buffer) => {
    for (let offset = 0; offset < buffer.length; offset += 16384) {
      channel.send(buffer.subarray(offset, Math.min(offset + 16384, buffer.length)));
    }
  };
  state.buffer = () => Buffer.concat(state.received);
  return state;
}

// Minimal WebSocket client framing (client frames are masked)
function wsFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function wsParse(buffer) {
  // Parses one unmasked server frame, returns { opcode, payload, rest } or undefined
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return undefined;
  return { opcode: opcode, payload: buffer.subarray(offset, offset + length), rest: buffer.subarray(offset + length) };
}

// ---------------------------------------------------------------------------
// Tests

async function testUnavailable(RED, nrPort, dashboardPort) {
  console.log('# werift missing');
  const instance = createInstance(RED, 'nowerift', 'hash-nowerift', dashboardPort);
  await sleep(50);
  assert.ok(routeExists(RED, instance.url), 'offer route registered');
  ok('node loads without werift, offer route registered');
  assert.strictEqual(p2p.loadWerift(), null);
  ok(`werift load error remembered: ${p2p.getWeriftError().message}`);
  const response = await postJson(nrPort, instance.url, { sdp: 'v=0\r\n', client: 'ios', version: 'test' });
  assert.strictEqual(response.status, 503);
  assert.deepStrictEqual(response.json, { error: 'p2p_unavailable' });
  ok('offer answered with 503 p2p_unavailable');
  assert.ok(instance.access.currentStatus.text === 'remote-access.status.serving', 'status serving');
  ok('tunnel status unaffected (serving)');
  await closeNode(instance.access);
  assert.ok(!routeExists(RED, instance.url));
  ok('route removed on close');
}

async function testMain(RED, werift, nrPort, dashboardPort) {
  console.log('# main flow');
  apiState.p2pByInstance['hash-main'] = { enabled: true, stun: [] };
  const main = createInstance(RED, 'main', 'hash-main', dashboardPort);
  await sleep(50);
  assert.strictEqual(main.config.p2p, true, 'p2p defaults to true');
  ok('remote-config.p2p defaults to true when undefined');
  assert.ok(routeExists(RED, main.url));
  ok('offer route registered on RED.httpNode');

  // Invalid request
  let response = await postJson(nrPort, main.url, { client: 'ios' });
  assert.strictEqual(response.status, 400);
  ok('offer without sdp -> 400');

  // Negotiation
  const app = await connectApp(werift, nrPort, main.url);
  assert.strictEqual(app.response.status, 200, 'answer status ' + app.response.text);
  assert.ok(typeof app.response.json.sdp === 'string' && app.response.json.sdp.startsWith('v=0'));
  assert.ok(/^[A-Za-z0-9_-]{8}$/.test(app.response.json.session), 'session id 8 chars');
  assert.ok(/a=candidate:/.test(app.response.json.sdp), 'answer contains candidates');
  ok(`answer received in ${app.answerMs} ms, session ${app.response.json.session}, candidates included`);
  assert.ok(app.answerMs < 1500, 'answer within budget');
  ok(`control channel open after ${app.connectMs} ms`);

  await waitFor(() => main.access.currentStatus && /1 direct/.test(main.access.currentStatus.text), 3000, 'status with direct count');
  ok(`status shows direct connection: "${main.access.currentStatus.text}"`);
  const pairLog = main.access.logs.find((l) => /direct connection established/.test(l));
  assert.ok(pairLog, 'verbose log with pair');
  ok(`verbose log: ${pairLog.replace(/^\[info\] /, '')}`);

  // Small HTTP request over tcp-1
  const pauseCounter = { count: 0 };
  const originalPause = net.Socket.prototype.pause;
  net.Socket.prototype.pause = function() { pauseCounter.count++; return originalPause.apply(this, arguments); };

  const small = openChannel(app, 'tcp-1');
  await timeout(small.opened, 5000, 'tcp-1 open');
  small.send(Buffer.from('GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
  await timeout(new Promise((resolve) => { small.onData = () => { if (small.closed) resolve(); }; }), 10000, 'tcp-1 response');
  const smallText = small.buffer().toString('utf8');
  assert.ok(smallText.startsWith('HTTP/1.1 200'), smallText);
  assert.ok(smallText.endsWith('hello from dashboard'), JSON.stringify(smallText));
  ok('HTTP GET /hello over tcp-1, channel closed after TCP close');

  // Large HTTP response over tcp-2 (backpressure)
  const big = openChannel(app, 'tcp-2');
  await timeout(big.opened, 5000, 'tcp-2 open');
  const bigStart = Date.now();
  big.send(Buffer.from('GET /big HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
  await timeout(new Promise((resolve) => { big.onData = () => { if (big.closed) resolve(); }; }), 120000, 'tcp-2 big response');
  const bigMs = Date.now() - bigStart;
  net.Socket.prototype.pause = originalPause;
  const bigBuffer = big.buffer();
  const headerEnd = bigBuffer.indexOf('\r\n\r\n');
  const header = bigBuffer.subarray(0, headerEnd).toString('utf8');
  const body = bigBuffer.subarray(headerEnd + 4);
  const contentLength = Number(/content-length: (\d+)/i.exec(header)[1]);
  assert.strictEqual(contentLength, BIG_BODY.length);
  assert.strictEqual(body.length, BIG_BODY.length, 'complete body');
  assert.strictEqual(sha256(body), BIG_HASH, 'body hash');
  const maxMessage = Math.max(...big.received.map((b) => b.length));
  assert.ok(maxMessage <= 16384, 'messages <= 16384 bytes');
  ok(`large response ${body.length} bytes complete, sha256 matches, ${big.received.length} messages (max ${maxMessage} bytes), ${bigMs} ms (${(body.length / 1024 / 1024 / (bigMs / 1000)).toFixed(1)} MB/s)`);
  assert.ok(pauseCounter.count > 0, 'tcp socket was paused');
  ok(`backpressure engaged: TCP socket paused ${pauseCounter.count} times`);

  // WebSocket over tcp-3
  const ws = openChannel(app, 'tcp-3');
  await timeout(ws.opened, 5000, 'tcp-3 open');
  const key = crypto.randomBytes(16).toString('base64');
  ws.send(Buffer.from(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  await waitFor(() => ws.buffer().indexOf('\r\n\r\n') >= 0, 5000, 'ws upgrade response');
  let wsBuffer = ws.buffer();
  const upgradeEnd = wsBuffer.indexOf('\r\n\r\n');
  const upgrade = wsBuffer.subarray(0, upgradeEnd).toString('utf8');
  assert.ok(upgrade.startsWith('HTTP/1.1 101'), upgrade);
  const expectedAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  assert.ok(upgrade.includes(expectedAccept));
  ok('WebSocket upgrade 101 over tcp-3');

  let consumed = upgradeEnd + 4;
  async function nextFrame() {
    let frame;
    await waitFor(() => { frame = wsParse(ws.buffer().subarray(consumed)); return frame !== undefined; }, 10000, 'ws frame');
    consumed = ws.buffer().length - frame.rest.length;
    return frame;
  }
  ws.send(wsFrame(1, Buffer.from('hello p2p')));
  let frame = await nextFrame();
  assert.strictEqual(frame.opcode, 1);
  assert.strictEqual(frame.payload.toString('utf8'), 'hello p2p');
  ok('WebSocket text echo');
  const wsBig = crypto.randomBytes(300 * 1024);
  ws.send(wsFrame(2, wsBig));
  frame = await nextFrame();
  assert.strictEqual(frame.opcode, 2);
  assert.strictEqual(sha256(frame.payload), sha256(wsBig));
  ok('WebSocket binary echo 300 KB (app -> node chunked, node -> app chunked)');

  // Closing the channel from the app closes the TCP connection
  ws.channel.close();
  await waitFor(() => dashboardState.wsClosed === 1, 5000, 'ws closed on dashboard');
  ok('closing the DataChannel closes the TCP/WebSocket connection on the dashboard');

  // Channel limit: control + 63 tcp channels allowed, the 64th tcp channel (65th channel) is closed
  const channels = [];
  for (let i = 0; i < 64; i++) channels.push(openChannel(app, `tcp-${10 + i}`));
  await timeout(Promise.all(channels.map((c) => c.opened)), 10000, 'channels open');
  await waitFor(() => channels[63].closed, 5000, '65th channel closed');
  await sleep(300);
  const openCount = channels.filter((c) => !c.closed).length;
  assert.strictEqual(openCount, 63, 'open channels ' + openCount);
  ok('channel limit: 64 channels per PeerConnection (control + 63 tcp), the 65th is closed');
  channels.forEach((c) => c.channel.close());
  await waitFor(() => channels.every((c) => c.closed), 10000, 'limit channels closed');

  // Heartbeat telemetry
  await sleep(200);
  heartbeatCalls[main.access.id]();
  await waitFor(() => apiState.heartbeats.length === 1, 2000, 'heartbeat');
  const telemetry = apiState.heartbeats[0].p2p;
  assert.ok(telemetry, 'heartbeat has p2p field');
  assert.strictEqual(telemetry.attempts, 1);
  assert.strictEqual(telemetry.direct, 1);
  assert.strictEqual(telemetry.failed, 0);
  assert.ok(['host4', 'host6'].includes(telemetry.pairtype), 'pairtype ' + telemetry.pairtype);
  ok(`heartbeat telemetry: ${JSON.stringify(telemetry)}`);
  await sleep(50);
  heartbeatCalls[main.access.id]();
  await waitFor(() => apiState.heartbeats.length === 2, 2000, 'heartbeat 2');
  assert.strictEqual(apiState.heartbeats[1].p2p, undefined);
  ok('counters reset after heartbeat (no p2p field when nothing happened)');

  return { main: main, app: app };
}

async function testLimits(RED, werift, nrPort, dashboardPort, main, app) {
  console.log('# limits');
  // 1 PC active (app). 3 more -> 4, the 5th is busy.
  const extra = [];
  for (let i = 0; i < 3; i++) {
    const peer = await createAppPeer(werift);
    const response = await postJson(nrPort, main.url, { sdp: peer.sdp, client: 'android', version: 'test' });
    assert.strictEqual(response.status, 200, response.text);
    extra.push(peer);
  }
  ok('4 PeerConnections accepted');
  const fifth = await createAppPeer(werift);
  let response = await postJson(nrPort, main.url, { sdp: fifth.sdp, client: 'android', version: 'test' });
  assert.strictEqual(response.status, 503);
  assert.deepStrictEqual(response.json, { error: 'p2p_busy' });
  assert.ok(main.access.logs.some((l) => /offer rejected, 4 peer connections active/.test(l)));
  ok('5th PeerConnection -> 503 p2p_busy');

  // Eviction: oldest PC without tcp channels, empty for longer than evictIdleMs
  p2p.LIMITS.evictIdleMs = 500;
  await sleep(700);
  response = await postJson(nrPort, main.url, { sdp: fifth.sdp, client: 'android', version: 'test' });
  assert.strictEqual(response.status, 200, response.text);
  assert.ok(main.access.logs.some((l) => /closed: evicted for a new connection/.test(l)));
  ok('oldest empty PeerConnection evicted after idle time, new offer accepted');
  await waitFor(() => !/direct/.test(main.access.currentStatus.text), 3000, 'direct count back to 0');
  ok(`status after eviction of the connected PC: "${main.access.currentStatus.text}"`);
  p2p.LIMITS.evictIdleMs = 60 * 1000;

  // Rate limit: 6 offers used so far (4 accepted, 1 busy, 1 evicting) -> 4 left, 11th is limited
  p2p.LIMITS.maxPeerConnections = 100;
  let limited = 0;
  let accepted = 0;
  for (let i = 0; i < 5; i++) {
    const peer = await createAppPeer(werift);
    response = await postJson(nrPort, main.url, { sdp: peer.sdp, client: 'ios', version: 'test' });
    if (response.status === 200) accepted++;
    if (response.status === 503 && response.json.error === 'p2p_busy') limited++;
    extra.push(peer);
  }
  assert.strictEqual(accepted, 4);
  assert.strictEqual(limited, 1);
  assert.ok(main.access.logs.some((l) => /offer rejected, rate limit reached/.test(l)));
  ok('rate limit 10 offers/min: 11th offer -> 503 p2p_busy');
  p2p.LIMITS.maxPeerConnections = 4;

  extra.concat([fifth]).forEach((peer) => peer.pc.close().catch(() => {}));
  await app.pc.close().catch(() => {});
}

async function testDisabled(RED, werift, nrPort, dashboardPort) {
  console.log('# disabled');
  const byConfig = createInstance(RED, 'cfgoff', 'hash-cfgoff', dashboardPort, { p2p: false });
  await sleep(50);
  const peer = await createAppPeer(werift);
  let response = await postJson(nrPort, byConfig.url, { sdp: peer.sdp, client: 'ios', version: 'test' });
  assert.strictEqual(response.status, 503);
  assert.deepStrictEqual(response.json, { error: 'p2p_disabled' });
  ok('remote-config p2p=false -> 503 p2p_disabled');

  apiState.p2pByInstance['hash-srvoff'] = { enabled: false, stun: ['stun:stun-dev.test:3478'] };
  const byServer = createInstance(RED, 'srvoff', 'hash-srvoff', dashboardPort);
  await sleep(50);
  response = await postJson(nrPort, byServer.url, { sdp: peer.sdp, client: 'ios', version: 'test' });
  assert.strictEqual(response.status, 503);
  assert.deepStrictEqual(response.json, { error: 'p2p_disabled' });
  ok('server p2p.enabled=false (instanceSlotRequest) -> 503 p2p_disabled');

  // Old server without p2p field: enabled, host candidates only
  const oldServer = createInstance(RED, 'oldsrv', 'hash-oldsrv', dashboardPort);
  await sleep(50);
  response = await postJson(nrPort, oldServer.url, { sdp: peer.sdp, client: 'ios', version: 'test' });
  assert.strictEqual(response.status, 200, response.text);
  assert.ok(!/typ srflx/.test(response.json.sdp));
  ok('server without p2p field -> enabled, only host candidates');

  // Unreachable STUN server: gathering is bounded by the vanilla ICE budget
  apiState.p2pByInstance['hash-stun'] = { enabled: true, stun: ['stun:192.0.2.1:3478'] };
  const stun = createInstance(RED, 'stun', 'hash-stun', dashboardPort);
  await sleep(50);
  const start = Date.now();
  response = await postJson(nrPort, stun.url, { sdp: peer.sdp, client: 'ios', version: 'test' });
  const ms = Date.now() - start;
  assert.strictEqual(response.status, 200, response.text);
  assert.ok(ms < 1500, 'answer within budget, took ' + ms);
  ok(`unreachable STUN server: answer after ${ms} ms (gathering capped at 500 ms instead of werift's 5 s)`);

  await peer.pc.close().catch(() => {});
  for (const instance of [byConfig, byServer, oldServer, stun]) {
    await closeNode(instance.access);
  }
}

function startHttpsDashboard() {
  // Self-signed certificate created at runtime with openssl
  const fs = require('fs');
  const os = require('os');
  const https = require('https');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotered-p2p-test-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const options = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  fs.rmSync(dir, { recursive: true, force: true });
  return new Promise((resolve) => {
    const server = https.createServer(options, (req, res) => {
      const body = Buffer.from('hello over https, encrypted: ' + req.socket.encrypted);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function testHttps(RED, werift, nrPort) {
  console.log('# https target');
  const httpsServer = await startHttpsDashboard();
  apiState.p2pByInstance['hash-https'] = { enabled: true, stun: [] };
  const instance = createInstance(RED, 'https', 'hash-https', httpsServer.address().port, { protocol: 'https', host: '127.0.0.1' });
  await sleep(50);
  const app = await connectApp(werift, nrPort, instance.url);
  assert.strictEqual(app.response.status, 200, app.response.text);
  const channel = openChannel(app, 'tcp-1');
  await timeout(channel.opened, 5000, 'tcp-1 open');
  channel.send(Buffer.from('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
  await timeout(new Promise((resolve) => { channel.onData = () => { if (channel.closed) resolve(); }; }), 10000, 'https response');
  const text = channel.buffer().toString('utf8');
  assert.ok(text.startsWith('HTTP/1.1 200'), JSON.stringify(text));
  assert.ok(text.endsWith('hello over https, encrypted: true'), JSON.stringify(text));
  ok('protocol https: node terminates TLS (self-signed), app receives plain HTTP over tcp-1');
  assert.ok(instance.access.logs.some((l) => /tcp-1 opened \(tls\)/.test(l)));
  ok('verbose log marks the tls channel');
  await closeNode(instance.access);
  await app.pc.close().catch(() => {});
  httpsServer.close();
}

async function testClose(RED, werift, nrPort, dashboardPort) {
  console.log('# close');
  apiState.p2pByInstance['hash-close'] = { enabled: true, stun: [] };
  const instance = createInstance(RED, 'close', 'hash-close', dashboardPort);
  await sleep(50);
  const app = await connectApp(werift, nrPort, instance.url);
  assert.strictEqual(app.response.status, 200);
  const channel = openChannel(app, 'tcp-1');
  await timeout(channel.opened, 5000, 'tcp-1 open');
  const wsBefore = dashboardState.tcpConnections;
  await waitFor(() => dashboardState.tcpConnections > wsBefore - 1, 1000, 'tcp connected');
  await closeNode(instance.access);
  assert.ok(!routeExists(RED, instance.url));
  ok('node close removes the offer route');
  await waitFor(() => channel.closed || app.pc.connectionState === 'closed' || app.pc.connectionState === 'failed', 15000, 'app notices close');
  ok(`node close tears down PeerConnections (app channel closed: ${channel.closed}, app pc: ${app.pc.connectionState})`);
  const response = await postJson(nrPort, instance.url, { sdp: app.sdp });
  assert.strictEqual(response.status, 404);
  ok('offer after close -> 404');
  await app.pc.close().catch(() => {});
}

async function main() {
  const dashboard = await startDashboard();
  const dashboardPort = dashboard.address().port;
  const RED = createMockRED();
  require(path.join(nodesDir, 'remote-config.js'))(RED);
  require(path.join(nodesDir, 'remote-access.js'))(RED);
  const nrServer = await new Promise((resolve) => { const s = RED.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const nrPort = nrServer.address().port;
  console.log(`dashboard on ${dashboardPort}, node-red mock on ${nrPort}, node ${process.version}`);

  if (EXPECT_UNAVAILABLE) {
    await testUnavailable(RED, nrPort, dashboardPort);
  } else {
    const werift = p2p.loadWerift();
    assert.ok(werift, 'werift loadable: ' + p2p.getWeriftError());
    const { main: mainInstance, app } = await testMain(RED, werift, nrPort, dashboardPort);
    await testLimits(RED, werift, nrPort, dashboardPort, mainInstance, app);
    await closeNode(mainInstance.access);
    await testDisabled(RED, werift, nrPort, dashboardPort);
    await testHttps(RED, werift, nrPort);
    await testClose(RED, werift, nrPort, dashboardPort);
  }

  console.log(`\nall ${passed} checks passed`);
  nrServer.close();
  dashboard.close();
  // werift keeps UDP sockets and timers of closed connections alive for a while
  setTimeout(() => process.exit(0), 200);
}

main().catch((error) => {
  console.error('\nFAILED:', error && error.stack ? error.stack : error);
  process.exit(1);
});
