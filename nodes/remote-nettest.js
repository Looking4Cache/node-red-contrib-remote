// Connection test for the remote-config editor (button "Verbindung testen").
//
// Checks everything a Remote-RED instance needs on this Node-RED host:
//   system:   Node.js, HTTP(S)_PROXY variables, ssh client, WebRTC library (werift)
//   local:    the target from the config node (host, port, protocol, base URL)
//   internet: DNS, HTTPS to contact-/api-, TCP 22 to proxy-, STUN (UDP 3478) to stun-,
//             the connection checks separately for IPv4 and IPv6
//   remote:   end to end: a heartbeat lets the server reach Node-RED through the tunnel
//
// Every check runs through runCheck(): it never rejects and has a hard timeout, so a
// hanging or failing check can neither block the response nor take down Node-RED (the
// first version crashed Node-RED by an unhandled rejection when the ping binary failed).
//
// Results carry locale keys (remote-config.nettest.*) and parameters, the editor
// translates them, so the texts follow the language of the editor.

const net = require('net');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const dns = require('dns');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const child_process = require('child_process');
const commons = require('./remote-commons');
const p2p = require('./remote-p2p');

const TIMEOUTS = {
  check: 8000,        // safety net per check
  dns: 4000,
  publicDns: 2000,
  target: 5000,
  https: 6000,
  ssh: 5000,
  sshClient: 3000,
  stun: 3000,
  heartbeat: 20000    // the server waits up to 30 s for Node-RED, we give up earlier
};

const STUN_COOKIE = 0x2112A442;
const PUBLIC_DNS_SERVERS = ['1.1.1.1', '9.9.9.9'];

// Only one test at a time (double clicks, several open editors)
let running = false;

// ---------------------------------------------------------------------------
// Helpers

function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: code || 'ETIMEDOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function runCheck(group, id, fn, timeoutMs) {
  // Runs one check. Always resolves with { group, id, status, msg, ... }.
  const started = Date.now();
  return withTimeout(Promise.resolve().then(fn), timeoutMs || TIMEOUTS.check)
    .catch((error) => {
      const timedOut = (error && error.code === 'ETIMEDOUT' && error.message === 'timeout');
      return { status: 'error', msg: timedOut ? 'common.timeout' : 'common.failed', params: { message: firstLine(error) } };
    })
    .then((result) => Object.assign({ group: group, id: id, ms: Date.now() - started }, result));
}

function firstLine(error) {
  return String((error && error.message) || error).split('\n')[0].substring(0, 200);
}

function classifyError(error) {
  // Maps network errors to a few codes, each has a message (err.*) and a hint (hint.*)
  if (error && Array.isArray(error.errors) && error.errors.length > 0) {
    // AggregateError of happy eyeballs / several addresses: the first one is representative
    return classifyError(error.errors[0]);
  }
  const code = String((error && (error.code || (error.cause && error.cause.code))) || '');
  const message = String((error && error.message) || error);
  if (/Certificate verification error/.test(message)) return 'tls';
  if (['ENOTFOUND', 'EAI_NONAME', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA'].includes(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (['ETIMEDOUT', 'ECONNABORTED', 'ESOCKETTIMEDOUT'].includes(code)) return 'timeout';
  if (['ECONNRESET', 'EPIPE'].includes(code) || /socket hang up/.test(message)) return 'reset';
  if (['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'ENETDOWN', 'EHOSTDOWN', 'EAFNOSUPPORT'].includes(code)) return 'unreachable';
  if (['EACCES', 'EPERM'].includes(code)) return 'blocked';
  if (code === 'EPROTO' || code.startsWith('ERR_SSL_') || code.startsWith('HPE_')) return 'protocol';
  return 'other';
}

function familyName(family) {
  return family === 6 ? 'IPv6' : 'IPv4';
}

function isBlockedAddress(address) {
  // DNS filters (Pi-hole, AdGuard) answer blocked names with 0.0.0.0 / :: / loopback
  return address === '0.0.0.0' || address === '::' || address === '::1' || /^127\./.test(address);
}

function localAddresses() {
  const addresses = new Set();
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((entry) => addresses.add(entry.address));
  });
  return addresses;
}

function isDocker() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    return /docker|containerd|kubepods|lxc/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch (error) {
    return false;
  }
}

function summarizeFamilies(results, okResult, port, proto, hostname) {
  // Combines per family results: all ok > ok, some ok > warn (one IP family broken), none > error
  const families = results.map((r) => ({ family: r.family, ok: r.ok, ms: r.ms, err: r.code }));
  const okCount = results.filter((r) => r.ok).length;
  const params = Object.assign({ host: hostname, port: port, proto: proto }, okResult.params);
  if (okCount === results.length) {
    return Object.assign({}, okResult, { status: 'ok', params: params, families: families });
  }
  if (okCount > 0) {
    const failed = results.find((r) => !r.ok);
    params.failed = familyName(failed.family);
    params.working = familyName(results.find((r) => r.ok).family);
    // Refused on one family is an active rejection (firewall, temporary ban), not a broken route
    const hint = (failed.code === 'refused') ? 'hint.refused' : (failed.family === 6 ? 'hint.partial6' : 'hint.partial4');
    return { status: 'warn', msg: 'common.partial', hint: hint, params: params, families: families };
  }
  const first = results[0];
  params.message = first.message;
  return { status: 'error', msg: 'err.' + first.code, hint: 'hint.' + first.code, params: params, families: families };
}

// ---------------------------------------------------------------------------
// Input

function parseInput(RED, query) {
  const fail = (text) => { throw Object.assign(new Error(text), { status: 400 }); };
  const input = {};

  input.region = String(query.region || '');
  if (!/^[a-z]{2,8}$/.test(input.region)) fail('invalid region');

  input.server = String(query.server || '').toLowerCase();
  if (input.server !== '' && !/^[a-z0-9][a-z0-9.-]{0,99}$/.test(input.server)) fail('invalid server');

  input.host = String(query.host || '').trim().replace(/^\[(.*)\]$/, '$1');
  if (input.host === '' || input.host.length > 253 || !/^[A-Za-z0-9._:%-]+$/.test(input.host)) fail('invalid host');

  input.port = parseInt(query.port, 10);
  if (!(input.port >= 1 && input.port <= 65535)) fail('invalid port');

  input.protocol = (query.protocol === 'https') ? 'https' : 'http';

  input.baseurl = String(query.baseurl || '/');
  if (!input.baseurl.startsWith('/')) input.baseurl = '/' + input.baseurl;
  if (input.baseurl.length > 1024 || /[\s\u0000-\u001f]/.test(input.baseurl)) fail('invalid baseurl');

  input.p2p = (query.p2p !== 'false');

  // Deployed state of this config node (undefined if new or not deployed yet)
  const configNode = query.id ? RED.nodes.getNode(String(query.id)) : null;
  input.configNode = (configNode && configNode.type === 'remote-config') ? configNode : undefined;
  input.accessNode = input.configNode ? findAccessNode(RED, input.configNode.id) : undefined;

  // The server is fixed after registration, use the deployed one if the form has none
  if (input.server === '' && input.configNode && input.configNode.server) {
    input.server = String(input.configNode.server);
  }
  return input;
}

function findAccessNode(RED, configId) {
  // Returns the running access node of the config node, null if it exists in the flows but
  // doesn't run (disabled flow), undefined if there is none
  let flowNode;
  RED.nodes.eachNode((n) => {
    if (flowNode === undefined && n.type === 'remote-access' && n.confignode === configId) flowNode = n;
  });
  if (flowNode === undefined) return undefined;
  return RED.nodes.getNode(flowNode.id) || null;
}

function getStunTarget(input) {
  // The STUN server the node really uses (from /instanceSlotRequest), else the convention
  let url;
  if (input.accessNode && input.accessNode.p2p && typeof input.accessNode.p2p.getStunList === 'function') {
    url = input.accessNode.p2p.getStunList()[0];
  }
  const match = /^stuns?:([^:?]+)(?::(\d+))?/.exec(url || '');
  if (match) return { host: match[1], port: parseInt(match[2] || '3478', 10) };
  if (input.server !== '') return { host: `stun-${input.server}`, port: 3478 };
  return undefined;
}

// ---------------------------------------------------------------------------
// System

function checkNodejs(ctx) {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  const params = {
    version: process.version,
    platform: `${os.platform()} ${os.arch()}${ctx.docker ? ' · Docker' : ''}`
  };
  if (major < 16) {
    return { status: 'warn', msg: 'node.old', hint: 'node.hint_old', params: params };
  }
  return { status: 'ok', msg: 'node.ok', params: params };
}

function checkProxyEnv() {
  // axios uses HTTP(S)_PROXY, ssh and STUN don't: worth knowing when analysing problems
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].filter((name) => process.env[name]);
  if (names.length === 0) return undefined;
  return { status: 'info', msg: 'proxyenv.set', hint: 'proxyenv.hint_set', params: { names: names.join(', ') } };
}

function checkSshClient() {
  // remote-access spawns "ssh" for the tunnel. "ssh -V" prints the version on stderr.
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch (error) { /* already gone */ }
      resolve(result);
    };
    const child = child_process.spawn('ssh', ['-V'], { windowsHide: true });
    const timer = setTimeout(() => finish({ status: 'ok', msg: 'ssh.ok', params: { version: 'ssh' } }), TIMEOUTS.sshClient);
    const collect = (data) => { output += data.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        finish({ status: 'error', msg: 'ssh.missing', hint: 'ssh.hint_missing' });
      } else {
        finish({ status: 'error', msg: 'ssh.error', hint: 'ssh.hint_missing', params: { message: firstLine(error) } });
      }
    });
    child.on('close', () => {
      const version = output.trim().split('\n')[0].substring(0, 80) || 'ssh';
      finish({ status: 'ok', msg: 'ssh.ok', params: { version: version } });
    });
  });
}

function checkWebrtc(ctx) {
  if (!ctx.p2p) {
    return { status: 'skip', msg: 'webrtc.disabled' };
  }
  if (p2p.loadWerift()) {
    return { status: 'ok', msg: 'webrtc.ok' };
  }
  return {
    status: 'warn', msg: 'webrtc.unavailable', hint: 'webrtc.hint_unavailable',
    params: { message: firstLine(p2p.getWeriftError()), version: process.version }
  };
}

// ---------------------------------------------------------------------------
// Local target

function httpStatus(url) {
  // Only the status line is of interest, the body (e.g. a big dashboard) is not downloaded
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.request(url, { method: 'GET', rejectUnauthorized: false, timeout: TIMEOUTS.target }, (res) => {
      resolve(res.statusCode);
      res.destroy();
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

async function checkTarget(ctx) {
  // Same target as the ssh tunnel (startSSH in remote-access.js)
  let host = ctx.host;
  if (host === 'localhost' && os.platform() === 'win32') host = '127.0.0.1';
  const urlHost = net.isIPv6(host) ? `[${host}]` : host;
  const url = `${ctx.protocol}://${urlHost}:${ctx.port}${ctx.baseurl}`;
  const params = { url: url, host: ctx.host, port: ctx.port, baseurl: ctx.baseurl, other: ctx.protocol === 'https' ? 'http' : 'https' };
  if (host === 'localhost' && ctx.docker) params.docker = true;

  let statusCode;
  try {
    statusCode = await httpStatus(url);
  } catch (error) {
    const code = classifyError(error);
    params.message = firstLine(error);
    const hint = ['refused', 'timeout', 'unreachable', 'protocol', 'dns', 'reset'].includes(code) ? code : 'other';
    return { status: 'error', msg: 'err.' + code, hint: 'target.hint_' + hint, params: params };
  }

  params.status = statusCode;
  if (statusCode === 404) {
    return { status: 'warn', msg: 'target.notfound', hint: 'target.hint_notfound', params: params };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { status: 'ok', msg: 'target.auth', params: params };
  }
  if (statusCode >= 400) {
    return { status: 'warn', msg: 'target.httperror', hint: 'target.hint_httperror', params: params };
  }
  return { status: 'ok', msg: 'target.ok', params: params };
}

// ---------------------------------------------------------------------------
// DNS

async function publicDnsKnows(hostname) {
  // Distinguishes "local DNS broken" from "no internet / DNS blocked" (only called on failure)
  try {
    const resolver = new dns.promises.Resolver({ timeout: TIMEOUTS.publicDns, tries: 1 });
    resolver.setServers(PUBLIC_DNS_SERVERS);
    const addresses = await withTimeout(resolver.resolve4(hostname), TIMEOUTS.publicDns + 500);
    return addresses.length > 0 ? 'known' : 'unknown';
  } catch (error) {
    return (error.code === 'ENOTFOUND' || error.code === 'ENODATA') ? 'unknown' : 'unreachable';
  }
}

async function checkDns(ctx) {
  const results = await Promise.all(ctx.hostnames.map(async (hostname) => {
    try {
      const addresses = await withTimeout(dns.promises.lookup(hostname, { all: true }), TIMEOUTS.dns);
      const usable = addresses.filter((a) => !isBlockedAddress(a.address));
      if (usable.length === 0) {
        return { hostname: hostname, ok: false, blocked: true };
      }
      const families = Array.from(new Set(usable.map((a) => a.family))).sort();
      ctx.resolved[hostname] = families;
      return { hostname: hostname, ok: true, families: families };
    } catch (error) {
      return { hostname: hostname, ok: false, code: error.code };
    }
  }));

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    const families = new Set();
    results.forEach((r) => r.families.forEach((f) => families.add(familyName(f))));
    return { status: 'ok', msg: 'dns.ok', params: { count: results.length, families: Array.from(families).join(' + ') } };
  }

  const params = { names: failed.map((r) => r.hostname).join(', ') };
  if (failed.some((r) => r.blocked)) {
    return { status: 'error', msg: 'dns.blocked', hint: 'dns.hint_blocked', params: params };
  }
  if (failed.every((r) => ctx.stun && r.hostname === ctx.stun.host)) {
    // Only the STUN name is missing: the direct connection is optional
    return { status: 'warn', msg: 'dns.failed', hint: 'dns.hint_stun', params: params };
  }
  const publicState = await publicDnsKnows(failed[0].hostname);
  const hint = { known: 'dns.hint_local', unknown: 'dns.hint_unknown', unreachable: 'dns.hint_offline' }[publicState];
  params.servers = PUBLIC_DNS_SERVERS.join(', ');
  return { status: 'error', msg: 'dns.failed', hint: hint, params: params };
}

// ---------------------------------------------------------------------------
// Remote-RED servers

async function checkHttps(ctx, hostname) {
  const families = ctx.resolved[hostname];
  if (!families) return { status: 'skip', msg: 'common.nodns', params: { host: hostname } };

  const axiosInstance = commons.createAxiosInstance();
  const results = await Promise.all(families.map(async (family) => {
    const started = Date.now();
    try {
      const response = await axiosInstance.get(`https://${hostname}/testNetwork`, { timeout: TIMEOUTS.https, family: family });
      if (response.data && response.data.status === 'OK') {
        return { family: family, ok: true, ms: Date.now() - started };
      }
      return { family: family, ok: false, code: 'unexpected', message: 'unexpected response' };
    } catch (error) {
      let code = classifyError(error);
      if (code === 'protocol') code = 'tls';  // something in between doesn't speak TLS to us
      if (error.response) code = 'unexpected';
      return { family: family, ok: false, code: code, message: firstLine(error) };
    }
  }));
  return summarizeFamilies(results, { msg: 'https.ok' }, 443, 'TCP', hostname);
}

function probeSsh(hostname, family) {
  // TCP connect to port 22 and wait for the SSH banner ("SSH-2.0-dropbear...")
  return new Promise((resolve) => {
    const started = Date.now();
    let connectedMs;
    let banner = '';
    let done = false;
    const socket = net.connect({ host: hostname, port: 22, family: family });
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(Object.assign({ family: family }, result));
    };
    const timer = setTimeout(() => {
      finish(connectedMs !== undefined ? { ok: false, code: 'nobanner', ms: connectedMs } : { ok: false, code: 'timeout', message: 'timeout' });
    }, TIMEOUTS.ssh);
    socket.on('connect', () => { connectedMs = Date.now() - started; });
    socket.on('data', (data) => {
      banner += data.toString('latin1');
      if (banner.includes('\n') || banner.length > 255) {
        const ok = banner.startsWith('SSH-');
        finish({ ok: ok, code: ok ? undefined : 'nobanner', ms: connectedMs, banner: banner.split(/\r?\n/)[0] });
      }
    });
    socket.on('error', (error) => finish({ ok: false, code: classifyError(error), message: firstLine(error) }));
    socket.on('close', () => finish(connectedMs !== undefined ? { ok: false, code: 'nobanner', ms: connectedMs } : { ok: false, code: 'reset', message: 'closed' }));
  });
}

async function checkSshPort(ctx) {
  const hostname = `proxy-${ctx.server}`;
  const families = ctx.resolved[hostname];
  if (!families) return { status: 'skip', msg: 'common.nodns', params: { host: hostname } };
  const results = await Promise.all(families.map((family) => probeSsh(hostname, family)));
  const result = summarizeFamilies(results, { msg: 'sshport.ok' }, 22, 'TCP', hostname);
  if (results.every((r) => r.code === 'nobanner')) {
    result.msg = 'sshport.nobanner';
    result.hint = 'sshport.hint_nobanner';
  }
  return result;
}

function parseStunResponse(message, transactionId) {
  // Binding success response, returns the (XOR-)MAPPED-ADDRESS or null
  if (message.length < 20 || message.readUInt16BE(0) !== 0x0101 || message.readUInt32BE(4) !== STUN_COOKIE) return null;
  if (!message.subarray(8, 20).equals(transactionId)) return null;
  const end = Math.min(message.length, 20 + message.readUInt16BE(2));
  const xorKey = Buffer.concat([message.subarray(4, 8), transactionId]);
  let mapped = null;
  let offset = 20;
  while (offset + 4 <= end) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const value = message.subarray(offset + 4, offset + 4 + length);
    const xor = (type === 0x0020);
    if ((xor || type === 0x0001) && value.length === length && length >= 8) {
      const port = value.readUInt16BE(2) ^ (xor ? 0x2112 : 0);
      const raw = Buffer.from(value.subarray(4, value[1] === 0x02 ? 20 : 8));
      if (xor) {
        for (let i = 0; i < raw.length; i++) raw[i] ^= xorKey[i];
      }
      let address;
      if (raw.length === 4) {
        address = Array.from(raw).join('.');
      } else if (raw.length === 16) {
        const groups = [];
        for (let i = 0; i < 16; i += 2) groups.push(raw.readUInt16BE(i).toString(16));
        address = groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
      }
      if (address && (xor || mapped === null)) mapped = { address: address, port: port };
    }
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return mapped;
}

function probeStun(hostname, port, family) {
  // One binding request with retransmissions, answers the public address seen by the server
  return new Promise((resolve) => {
    const started = Date.now();
    const transactionId = crypto.randomBytes(12);
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0);
    request.writeUInt16BE(0, 2);
    request.writeUInt32BE(STUN_COOKIE, 4);
    transactionId.copy(request, 8);

    const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    const timers = [];
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      try { socket.close(); } catch (error) { /* already closed */ }
      resolve(Object.assign({ family: family }, result));
    };
    socket.on('error', (error) => finish({ ok: false, code: classifyError(error), message: firstLine(error) }));
    socket.on('message', (message) => {
      const mapped = parseStunResponse(message, transactionId);
      if (mapped) finish({ ok: true, ms: Date.now() - started, mapped: mapped });
    });
    const send = () => {
      if (done) return;
      socket.send(request, port, hostname, (error) => {
        if (error) finish({ ok: false, code: classifyError(error), message: firstLine(error) });
      });
    };
    [0, 500, 1500].forEach((delay) => timers.push(setTimeout(send, delay)));
    timers.push(setTimeout(() => finish({ ok: false, code: 'timeout', message: 'no STUN response' }), TIMEOUTS.stun));
  });
}

async function checkStun(ctx) {
  if (!ctx.p2p) return { status: 'skip', msg: 'webrtc.disabled' };
  if (!ctx.stun) return { status: 'skip', msg: 'common.notregistered' };
  const hostname = ctx.stun.host;
  const families = ctx.resolved[hostname];
  if (!families) return { status: 'skip', msg: 'common.nodns', params: { host: hostname } };

  const results = await Promise.all(families.map((family) => probeStun(hostname, ctx.stun.port, family)));
  const addresses = results.filter((r) => r.ok).map((r) => r.mapped.address).join(', ');
  const result = summarizeFamilies(results, { msg: 'stun.ok', params: { addresses: addresses } }, ctx.stun.port, 'UDP', hostname);
  if (result.status === 'error') {
    // Direct connection is optional, remote access keeps working over the tunnel
    result.status = 'warn';
    result.hint = 'stun.hint_blocked';
  }
  // Public address equal to a local one: no NAT on this IP family (best case for a direct connection)
  const locals = localAddresses();
  result.families.forEach((f, i) => {
    if (results[i].ok) f.nat = !locals.has(results[i].mapped.address);
  });
  return result;
}

// ---------------------------------------------------------------------------
// End to end

async function checkTunnel(ctx) {
  const config = ctx.configNode;
  if (!config) return { status: 'skip', msg: 'tunnel.notdeployed' };
  if (!config.instancehash || !config.server) return { status: 'skip', msg: 'common.notregistered' };
  if (!config.instanceauth) return { status: 'error', msg: 'tunnel.backup', hint: 'tunnel.hint_backup' };

  const params = { target: `${config.host}:${config.port}` };
  const access = ctx.accessNode;
  if (access === undefined) return { status: 'warn', msg: 'tunnel.noaccess', hint: 'tunnel.hint_noaccess' };
  if (access === null) return { status: 'warn', msg: 'tunnel.accessinactive', hint: 'tunnel.hint_noaccess' };
  if (!access.serving) {
    params.statuskey = access.statustext || '';
    // commerror: the slot request at the API failed, banned: the server rejected the instance
    const hint = {
      'remote-access.status.commerror': 'tunnel.hint_commerror',
      'remote-access.status.banned': 'tunnel.hint_auth'
    }[params.statuskey] || 'tunnel.hint_notserving';
    return { status: 'error', msg: 'tunnel.notserving', hint: hint, params: params };
  }

  // The server checks the tunnel to Node-RED, exactly like the regular heartbeat (without telemetry)
  let response;
  try {
    response = await commons.createAxiosInstance().post(`https://api-${config.server}/heartbeat`, {
      'instancehash': config.instancehash,
      'instanceauth': config.instanceauth,
      'version': commons.getNodeVersion()
    }, { timeout: TIMEOUTS.heartbeat });
  } catch (error) {
    // 400 (unknown instance, wrong instanceauth) and 401/403 (banned): the server rejects the instance
    const status = error.response && error.response.status;
    if (status === 400 || status === 401 || status === 403) {
      return { status: 'error', msg: 'tunnel.auth', hint: 'tunnel.hint_auth', params: { message: commons.getNetworkErrorString(error) } };
    }
    const code = classifyError(error);
    params.message = firstLine(error);
    params.host = `api-${config.server}`;
    params.port = 443;
    params.proto = 'TCP';
    return { status: 'error', msg: 'err.' + code, hint: 'hint.' + code, params: params };
  }

  params.direct = access.p2p ? access.p2p.getDirectCount() : 0;
  switch (response.data && response.data.status) {
    case 'OK':
      return { status: 'ok', msg: params.direct > 0 ? 'tunnel.ok_direct' : 'tunnel.ok', params: params };
    case 'NOTFOUND':
      return { status: 'warn', msg: 'tunnel.notfound', hint: 'tunnel.hint_notfound', params: Object.assign(params, { baseurl: config.baseurl }) };
    case 'NOTCONNECTED':
      return { status: 'error', msg: 'tunnel.notconnected', hint: 'tunnel.hint_notconnected', params: params };
    default:
      return { status: 'error', msg: 'tunnel.target', hint: 'tunnel.hint_target', params: params };
  }
}

// ---------------------------------------------------------------------------
// Summary for the three tiles in the editor

function summarize(checks, ctx) {
  const byId = {};
  checks.forEach((c) => { byId[c.id] = c; });
  const anyFamilyOk = (c) => c && Array.isArray(c.families) && c.families.some((f) => f.ok);

  // App verbinden: contact-<region> must be reachable
  const register = (byId.contact.status === 'ok' || byId.contact.status === 'warn') ? byId.contact.status : 'error';

  // Fernzugriff: end to end result if available, else the prerequisites
  let tunnel;
  if (byId.tunnel.status !== 'skip') {
    tunnel = byId.tunnel.status;
  } else if (byId.ssh.status === 'error') {
    tunnel = 'error';
  } else if (ctx.server === '') {
    tunnel = 'unknown';
  } else {
    tunnel = (anyFamilyOk(byId.api) && anyFamilyOk(byId.sshport)) ? 'likely' : 'error';
  }

  // Direktverbindung: library and STUN, the network of the phone decides the rest
  let direct;
  if (!ctx.p2p) {
    direct = 'disabled';
  } else if (byId.webrtc.status !== 'ok') {
    direct = 'error';
  } else if (byId.stun.status === 'skip') {
    direct = 'unknown';
  } else {
    direct = anyFamilyOk(byId.stun) ? 'likely' : 'error';
  }

  return { register: register, tunnel: tunnel, direct: direct };
}

// ---------------------------------------------------------------------------

async function run(RED, query) {
  const ctx = parseInput(RED, query);
  if (running) {
    throw Object.assign(new Error('busy'), { status: 409 });
  }
  running = true;
  try {
    ctx.docker = isDocker();
    ctx.resolved = {};
    ctx.stun = ctx.p2p ? getStunTarget(ctx) : undefined;
    ctx.hostnames = [`contact-${ctx.region}.remote-red.com`];
    if (ctx.server !== '') {
      ctx.hostnames.push(`api-${ctx.server}`, `proxy-${ctx.server}`);
    }
    if (ctx.stun && !ctx.hostnames.includes(ctx.stun.host)) {
      ctx.hostnames.push(ctx.stun.host);
    }

    // The end to end check doesn't depend on the others and takes longest, start it first
    const tunnelPromise = runCheck('remote', 'tunnel', () => checkTunnel(ctx), TIMEOUTS.heartbeat + 2000);

    const phase1 = await Promise.all([
      runCheck('system', 'node', () => checkNodejs(ctx)),
      runCheck('system', 'proxyenv', () => checkProxyEnv()),
      runCheck('system', 'ssh', () => checkSshClient()),
      runCheck('system', 'webrtc', () => checkWebrtc(ctx)),
      runCheck('local', 'target', () => checkTarget(ctx)),
      runCheck('internet', 'dns', () => checkDns(ctx))
    ]);

    const notRegistered = () => ({ status: 'skip', msg: 'common.notregistered' });
    const phase2 = await Promise.all([
      runCheck('internet', 'contact', () => checkHttps(ctx, `contact-${ctx.region}.remote-red.com`)),
      runCheck('internet', 'api', () => ctx.server !== '' ? checkHttps(ctx, `api-${ctx.server}`) : notRegistered()),
      runCheck('internet', 'sshport', () => ctx.server !== '' ? checkSshPort(ctx) : notRegistered()),
      runCheck('internet', 'stun', () => checkStun(ctx))
    ]);

    // proxyenv only appears when proxy variables are set
    const checks = phase1.concat(phase2, [await tunnelPromise]).filter((c) => c.status !== undefined);

    // The target answers locally but not through the tunnel: the ssh process is still connecting or hangs
    const tunnelCheck = checks.find((c) => c.id === 'tunnel');
    const targetCheck = checks.find((c) => c.id === 'target');
    if (tunnelCheck.msg === 'tunnel.target' && targetCheck.status !== 'error') {
      tunnelCheck.hint = 'tunnel.hint_forward';
    }

    const deployed = ctx.configNode;
    const undeployed = !!deployed && (String(deployed.host) !== ctx.host || String(deployed.port) !== String(ctx.port) ||
      String(deployed.protocol) !== ctx.protocol || String(deployed.baseurl) !== ctx.baseurl || (deployed.p2p !== false) !== ctx.p2p);

    return {
      timestamp: new Date().toISOString(),
      version: commons.getNodeVersion(),
      server: ctx.server,
      region: ctx.region,
      undeployed: undeployed,
      checks: checks,
      summary: summarize(checks, ctx)
    };
  } finally {
    running = false;
  }
}

module.exports = {
  run: run,
  // Exposed for tests
  _parseStunResponse: parseStunResponse,
  _classifyError: classifyError
};
