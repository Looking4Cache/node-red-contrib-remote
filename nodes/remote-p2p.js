// Direct connection (WebRTC/ICE) between the Remote-RED app and this Node-RED.
//
// The app sends its SDP offer through the existing proxy + SSH tunnel to
// POST /contrib-remote/webrtc/offer/<instancehash>. This module answers it
// (vanilla ICE, all candidates in the answer) and maps every DataChannel with
// the label "tcp-<n>" to exactly one TCP connection to host:port of the
// remote-config node. See WEBRTCICE-KONZEPT.md, chapters 5, 6, 8, 10 and
// appendix A (binding contract).
//
// werift is an optional dependency. If it can't be loaded (old Node.js,
// failed install), the endpoint answers 503 p2p_unavailable and everything
// else keeps working over the proxy.

const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');
const RateLimiter = require('limiter').RateLimiter;

// Limits and tuning values (appendix A.4 / A.5). Exported so tests can shorten timers.
const LIMITS = {
  maxPeerConnections: 4,          // per access node
  maxChannels: 64,                // DataChannels per PeerConnection
  evictIdleMs: 60 * 1000,         // a PC without tcp-* channels may be evicted after this time
  idleCloseMs: 5 * 60 * 1000,     // a PC without tcp-* channels is closed after this time
  connectTimeoutMs: 30 * 1000,    // a PC whose control channel never opens is closed after this time
  gatherTimeoutMs: 500,           // upper bound for ICE candidate gathering (vanilla ICE)
  answerTimeoutMs: 5000,          // safety net for the whole answer creation
  offersPerMinute: 10,            // rate limit per access node
  chunkSize: 16384,               // max bytes per DataChannel message
  bufferedAmountLowThreshold: 262144,
  bufferedAmountHighWater: 1048576,
  maxPendingBytes: 4 * 1024 * 1024,    // data from the app buffered before TCP connect
  maxTcpWriteBuffer: 16 * 1024 * 1024, // see writeToSocket()
  closeFlushTimeoutMs: 10 * 1000,      // max wait for outgoing data before a channel is closed
  maxSdpLength: 64 * 1024,
  maxBodyLength: 256 * 1024
};

// Upper bound of a telemetry counter accepted by the server (remoteP2pConfig.js)
const TELEMETRY_COUNTER_MAX = 100000;

// werift is loaded once per process, the result (module or error) is remembered.
let weriftModule;
let weriftError;

function loadWerift() {
  if (weriftModule === undefined && weriftError === undefined) {
    try {
      weriftModule = require('werift');
    } catch (error) {
      weriftModule = null;
      weriftError = error;
    }
  }
  return weriftModule || null;
}

function getWeriftError() {
  loadWerift();
  return weriftError;
}

function createSessionId() {
  // 8 characters, only used to correlate log lines
  return crypto.randomBytes(6).toString('base64url');
}

function getTargetHost(confignode) {
  // Same target as the ssh tunnel (startSSH in remote-access.js)
  let host = confignode.host;
  if (host === 'localhost' && os.platform() === 'win32') {
    host = '127.0.0.1';
  }
  return host;
}

function readJsonBody(req) {
  // Node-RED usually parses JSON bodies on httpNode already. If not, read the stream ourselves.
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && Object.keys(req.body).length > 0) {
      resolve(req.body);
      return;
    }
    if (req.readableEnded || req.complete) {
      // Stream was consumed by a body parser that produced no usable object
      resolve(typeof req.body === 'string' ? JSON.parse(req.body) : {});
      return;
    }
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > LIMITS.maxBodyLength) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isIPv6(address) {
  return typeof address === 'string' && net.isIPv6(address);
}

function describePair(pc) {
  // Determines the selected candidate pair: host4 / host6 / srflx4 / srflx6 or unknown.
  // The local candidate of a pair is always a host candidate (ICE pairs from the base),
  // so the remote type decides whether NAT traversal (srflx/prflx) was involved.
  try {
    for (const iceTransport of pc.iceTransports) {
      const connection = iceTransport.connection;
      if (!connection) continue;
      const pair = connection.nominated || (connection.candidatePairs || []).find((p) => p.nominated);
      if (!pair) continue;
      const local = pair.localCandidate;
      const remote = pair.remoteCandidate;
      const types = [local && local.type, remote && remote.type];
      const kind = types.some((t) => t === 'srflx' || t === 'prflx' || t === 'relay') ? 'srflx' : 'host';
      const family = (isIPv6(local && local.host) || isIPv6(remote && remote.host)) ? '6' : '4';
      return {
        pairtype: kind + family,
        detail: `${local ? local.type : '?'} ${local ? local.host : '?'} <-> ${remote ? remote.type : '?'} ${remote ? remote.host : '?'}`
      };
    }
  } catch (error) {
    // werift internals changed: fall through to unknown
  }
  return { pairtype: 'unknown', detail: 'unknown' };
}

function prepareIceTransports(pc, stunList) {
  // werift quirks, applied after setRemoteDescription (transports exist) and before
  // setLocalDescription (gathering starts there):
  // 1. Without a STUN server werift falls back to stun.l.google.com. The concept forbids
  //    third-party STUN, so the fallback is removed when the server sent no STUN list.
  // 2. werift waits up to 5 s for a STUN response before gathering completes, and it only
  //    starts the connectivity checks after gathering completed. The STUN timeout is
  //    lowered to the vanilla ICE budget, so the answer is ready within ~500 ms.
  const gatherTimeoutSeconds = LIMITS.gatherTimeoutMs / 1000;
  for (const iceTransport of pc.iceTransports) {
    const connection = iceTransport.connection;
    if (!connection) continue;
    if (stunList.length === 0) {
      connection.stunServer = undefined;
    }
    const proto = Object.getPrototypeOf(connection);
    if (typeof proto.getCandidatePromises === 'function' && !Object.prototype.hasOwnProperty.call(connection, 'getCandidatePromises')) {
      connection.getCandidatePromises = function(addresses) {
        return proto.getCandidatePromises.call(this, addresses, gatherTimeoutSeconds);
      };
    }
  }
}

async function closePeerConnection(pc) {
  // werift's close() stops DTLS/ICE before SCTP, so the SCTP ABORT never reaches the app
  // and it only notices the end through ICE consent expiry (about 30 s). Stopping SCTP
  // first sends the ABORT while the transport is still up; the app closes its channels at once.
  try {
    if (pc.sctpTransport && pc.connectionState === 'connected') {
      await withTimeout(pc.sctpTransport.stop(), 1000, 'sctp stop timeout');
    }
  } catch (error) {
    // close() below cleans up anyway
  }
  await pc.close();
}

function createManager(node, options) {
  // One manager per remote-access node
  options = options || {};
  const onDirectCountChange = options.onDirectCountChange || function() {};
  const sessions = new Map();
  const limiter = new RateLimiter(LIMITS.offersPerMinute, 'minute', true);
  let serverEnabled = true;  // p2p.enabled from /instanceSlotRequest
  let stunList = [];         // p2p.stun from /instanceSlotRequest
  let closed = false;
  let lastDirectCount = 0;
  const telemetry = { attempts: 0, direct: 0, failed: 0, pairtype: undefined };

  function verbose(text) {
    if (node.verbose) {
      node.log('p2p: ' + text);
    }
  }

  function isEnabledByConfig() {
    return !(node.confignode && node.confignode.p2p === false);
  }

  function setServerConfig(p2p) {
    // p2p object from the /instanceSlotRequest response. Missing (old server) means enabled without STUN.
    if (p2p === undefined || p2p === null || typeof p2p !== 'object') {
      serverEnabled = true;
      stunList = [];
    } else {
      serverEnabled = p2p.enabled !== false;
      stunList = Array.isArray(p2p.stun) ? p2p.stun.filter((s) => typeof s === 'string' && /^stuns?:/.test(s)) : [];
    }
    verbose(`server config: enabled=${serverEnabled} stun=${JSON.stringify(stunList)}`);
    if (!serverEnabled) {
      closeAll('disabled by server');
    }
  }

  function getDirectCount() {
    let count = 0;
    sessions.forEach((session) => {
      if (session.controlOpen && !session.closed) count++;
    });
    return count;
  }

  function notifyDirectCount() {
    const count = getDirectCount();
    if (count !== lastDirectCount) {
      lastDirectCount = count;
      try {
        onDirectCountChange(count);
      } catch (error) {
        node.error('p2p: status update failed: ' + error);
      }
    }
  }

  function getTelemetry() {
    // Counters since the last successful heartbeat, undefined if nothing happened.
    // pairtype is only sent if a direct connection was established, so the server
    // keeps the last known pair type otherwise. Counters are capped like on the server.
    if (telemetry.attempts === 0 && telemetry.direct === 0 && telemetry.failed === 0) {
      return undefined;
    }
    const result = {
      attempts: Math.min(telemetry.attempts, TELEMETRY_COUNTER_MAX),
      direct: Math.min(telemetry.direct, TELEMETRY_COUNTER_MAX),
      failed: Math.min(telemetry.failed, TELEMETRY_COUNTER_MAX)
    };
    if (telemetry.pairtype !== undefined) {
      result.pairtype = telemetry.pairtype;
    }
    return result;
  }

  function commitTelemetry(sent) {
    // Called after the heartbeat was accepted. Subtracts what was sent, so events that
    // happened while the request was in flight are reported with the next heartbeat.
    telemetry.attempts = Math.max(0, telemetry.attempts - sent.attempts);
    telemetry.direct = Math.max(0, telemetry.direct - sent.direct);
    telemetry.failed = Math.max(0, telemetry.failed - sent.failed);
    if (sent.pairtype !== undefined && telemetry.pairtype === sent.pairtype && telemetry.direct === 0) {
      telemetry.pairtype = undefined;
    }
  }

  function scheduleIdleClose(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      closeSession(session, `idle for ${Math.round(LIMITS.idleCloseMs / 1000)} s without tcp channel`);
    }, LIMITS.idleCloseMs);
  }

  function makeRoom() {
    // Returns true if a new PeerConnection may be created. Evicts the oldest PC without
    // tcp-* channels if it has been empty for more than evictIdleMs (appendix A.5).
    if (sessions.size < LIMITS.maxPeerConnections) return true;
    const now = Date.now();
    let candidate;
    sessions.forEach((session) => {
      if (session.tcpCount === 0 && !session.negotiating && now - session.emptySince > LIMITS.evictIdleMs) {
        if (candidate === undefined || session.createdAt < candidate.createdAt) {
          candidate = session;
        }
      }
    });
    if (candidate) {
      closeSession(candidate, 'evicted for a new connection');
      return sessions.size < LIMITS.maxPeerConnections;
    }
    return false;
  }

  function closeSession(session, reason) {
    if (session.closed) return;
    session.closed = true;
    session.closeReason = reason;
    clearTimeout(session.idleTimer);
    clearTimeout(session.connectTimer);
    sessions.delete(session.id);
    if (!session.everDirect) {
      telemetry.failed++;
    }
    session.sockets.forEach((socket) => socket.destroy());
    session.sockets.clear();
    const lifetime = Date.now() - session.createdAt;
    verbose(`[${session.id}] closed: ${reason} (lifetime ${lifetime} ms, channels ${session.channelsTotal}, max parallel tcp ${session.peakTcp})`);
    if (session.pc) {
      closePeerConnection(session.pc).catch((error) => verbose(`[${session.id}] close error: ${error.message}`));
    }
    notifyDirectCount();
  }

  function closeAll(reason) {
    Array.from(sessions.values()).forEach((session) => closeSession(session, reason));
  }

  function shutdown() {
    closed = true;
    closeAll('node closed');
  }

  function attachPeerConnection(session) {
    const pc = session.pc;

    pc.connectionStateChange.subscribe((state) => {
      verbose(`[${session.id}] connection state ${state}`);
      if (state === 'failed' || state === 'closed') {
        closeSession(session, `connection ${state}`);
      }
    });

    pc.onDataChannel.subscribe((channel) => {
      if (session.closed) {
        channel.close();
        return;
      }
      session.channelCount++;
      session.channelsTotal++;
      if (session.channelCount > LIMITS.maxChannels) {
        // werift fires datachannel before the channel is set to open; closing now would be
        // overwritten by that open. Close it right after.
        verbose(`[${session.id}] channel '${channel.label}' rejected, limit of ${LIMITS.maxChannels} reached`);
        channel.addEventListener('close', () => { session.channelCount--; });
        setImmediate(() => channel.close());
        return;
      }
      if (channel.label === 'control') {
        attachControlChannel(session, channel);
      } else if (typeof channel.label === 'string' && channel.label.startsWith('tcp-')) {
        attachTcpChannel(session, channel);
      } else {
        verbose(`[${session.id}] unknown channel label '${channel.label}', closing`);
        channel.addEventListener('close', () => { session.channelCount--; });
        setImmediate(() => channel.close());
      }
    });
  }

  function attachControlChannel(session, channel) {
    // Ready signal: open = direct path active. Incoming messages (ping) are ignored.
    const onOpen = () => {
      if (session.closed || session.controlOpen) return;
      session.controlOpen = true;
      clearTimeout(session.connectTimer);
      if (!session.everDirect) {
        session.everDirect = true;
        telemetry.direct++;
      }
      const pair = describePair(session.pc);
      telemetry.pairtype = pair.pairtype;
      verbose(`[${session.id}] direct connection established after ${Date.now() - session.createdAt} ms, pair ${pair.pairtype} (${pair.detail})`);
      notifyDirectCount();
    };
    channel.addEventListener('open', onOpen);
    if (channel.readyState === 'open') onOpen();
    channel.addEventListener('message', () => {});
    channel.addEventListener('close', () => {
      session.channelCount--;
      if (!session.closed) {
        session.controlOpen = false;
        closeSession(session, 'control channel closed by app');
      }
    });
  }

  function attachTcpChannel(session, channel) {
    // Exactly one TCP connection to host:port of the config node. Nothing from the request
    // or the channel influences the target (chapter 6.2).
    const confignode = node.confignode;
    const host = getTargetHost(confignode);
    const port = Number(confignode.port);
    const label = channel.label;
    let connected = false;
    let finished = false;
    let pending = [];
    let pendingBytes = 0;

    session.tcpCount++;
    session.peakTcp = Math.max(session.peakTcp, session.tcpCount);
    clearTimeout(session.idleTimer);

    // https targets: the node terminates TLS to the local target itself, the DataChannel
    // always carries plain HTTP (DTLS already encrypts the path, appendix A.4). The
    // certificate is not verified, like the heartbeat check of the server.
    const useTls = confignode.protocol === 'https';
    const socket = useTls
      ? tls.connect({ host: host, port: port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, autoSelectFamily: true })
      : net.connect({ host: host, port: port, autoSelectFamily: true });
    socket.setNoDelay(true);
    session.sockets.add(socket);
    verbose(`[${session.id}] ${label} opened${useTls ? ' (tls)' : ''} (tcp channels ${session.tcpCount}, total channels ${session.channelCount})`);

    channel.bufferedAmountLowThreshold = LIMITS.bufferedAmountLowThreshold;

    function finish(reason, closedByApp) {
      // Full close in both directions (no half-close, appendix A.4)
      if (finished) return;
      finished = true;
      pending = [];
      session.sockets.delete(socket);
      session.tcpCount--;
      if (session.tcpCount === 0) {
        session.emptySince = Date.now();
        if (!session.closed) scheduleIdleClose(session);
      }
      verbose(`[${session.id}] ${label} closed: ${reason} (tcp channels ${session.tcpCount})`);
      if (!socket.destroyed) {
        // Let queued data reach Node-RED, then make sure the socket really goes away
        socket.end();
        setTimeout(() => socket.destroy(), 2000).unref();
      }
      if (!closedByApp) {
        closeChannelWhenFlushed(channel);
      }
    }

    function writeToSocket(data) {
      // werift has no API to stop reading from a DataChannel, so the remote can't be
      // throttled from here. The app sends little data (requests, WebSocket frames);
      // a runaway write buffer is treated as an error instead of growing without limit.
      socket.write(data);
      if (socket.writableLength > LIMITS.maxTcpWriteBuffer) {
        node.warn(`p2p: [${session.id}] ${label} write buffer exceeded, closing connection`);
        socket.destroy();
        finish('tcp write buffer exceeded');
      }
    }

    socket.on(useTls ? 'secureConnect' : 'connect', () => {
      connected = true;
      pending.forEach((data) => writeToSocket(data));
      pending = [];
      pendingBytes = 0;
    });

    socket.on('data', (data) => {
      if (channel.readyState !== 'open') return;
      try {
        for (let offset = 0; offset < data.length; offset += LIMITS.chunkSize) {
          channel.send(data.subarray(offset, Math.min(offset + LIMITS.chunkSize, data.length)));
        }
      } catch (error) {
        socket.destroy();
        finish('send error: ' + error.message);
        return;
      }
      if (channel.bufferedAmount > LIMITS.bufferedAmountHighWater && !socket.isPaused()) {
        socket.pause();
      }
    });

    socket.on('error', (error) => {
      finish('tcp error: ' + (error.code || error.message));
    });

    socket.on('close', () => {
      finish('tcp closed');
    });

    channel.addEventListener('bufferedamountlow', () => {
      if (!finished && socket.isPaused()) {
        socket.resume();
      }
    });

    channel.addEventListener('message', (event) => {
      if (finished) return;
      let data = event.data;
      if (typeof data === 'string') data = Buffer.from(data, 'utf8');
      if (connected) {
        writeToSocket(data);
      } else {
        pendingBytes += data.length;
        if (pendingBytes > LIMITS.maxPendingBytes) {
          socket.destroy();
          finish('too much data before tcp connect');
          return;
        }
        pending.push(data);
      }
    });

    channel.addEventListener('close', () => {
      session.channelCount--;
      finish('closed by app', true);
    });
  }

  function closeChannelWhenFlushed(channel) {
    // Close the channel after werift handed all queued data to SCTP, so the tail of a
    // response is not cut off when Node-RED closes the TCP connection right after sending.
    if (channel.readyState === 'closing' || channel.readyState === 'closed') return;
    if (channel.bufferedAmount === 0) {
      channel.close();
      return;
    }
    const timer = setTimeout(() => channel.close(), LIMITS.closeFlushTimeoutMs);
    channel.bufferedAmountLowThreshold = 0;
    channel.addEventListener('bufferedamountlow', () => {
      if (channel.bufferedAmount === 0) {
        clearTimeout(timer);
        channel.close();
      }
    });
  }

  async function createAnswer(session, offerSdp) {
    const werift = loadWerift();
    const pc = new werift.RTCPeerConnection({
      iceServers: stunList.map((url) => ({ urls: url })),
      iceUseIpv4: true,
      iceUseIpv6: true
    });
    session.pc = pc;
    attachPeerConnection(session);

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    prepareIceTransports(pc, stunList);
    const answer = await pc.createAnswer();
    // Gathering runs inside setLocalDescription and is bounded by prepareIceTransports
    await pc.setLocalDescription(answer);
    const local = pc.localDescription;
    if (!local || !local.sdp) {
      throw new Error('no local description');
    }
    return local.sdp;
  }

  async function handleOffer(req, res) {
    const reject = (status, error) => {
      if (!res.headersSent) res.status(status).json({ 'error': error });
    };

    if (closed || !isEnabledByConfig() || !serverEnabled) {
      reject(503, 'p2p_disabled');
      return;
    }
    if (!loadWerift()) {
      verbose(`werift not available: ${weriftError ? String(weriftError.message).split('\n')[0] : 'unknown'}`);
      reject(503, 'p2p_unavailable');
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      reject(400, 'invalid_request');
      return;
    }
    const offerSdp = body ? body.sdp : undefined;
    if (typeof offerSdp !== 'string' || offerSdp.length === 0 || offerSdp.length > LIMITS.maxSdpLength || !offerSdp.startsWith('v=0')) {
      reject(400, 'invalid_request');
      return;
    }

    if (!limiter.tryRemoveTokens(1)) {
      verbose('offer rejected, rate limit reached');
      reject(503, 'p2p_busy');
      return;
    }
    if (!makeRoom()) {
      verbose(`offer rejected, ${sessions.size} peer connections active`);
      reject(503, 'p2p_busy');
      return;
    }

    const now = Date.now();
    const session = {
      id: createSessionId(),
      pc: undefined,
      createdAt: now,
      emptySince: now,
      negotiating: true,
      controlOpen: false,
      everDirect: false,
      tcpCount: 0,
      peakTcp: 0,
      channelCount: 0,
      channelsTotal: 0,
      sockets: new Set(),
      idleTimer: undefined,
      connectTimer: undefined,
      closed: false,
      closeReason: undefined
    };
    sessions.set(session.id, session);
    telemetry.attempts++;
    const client = typeof body.client === 'string' ? body.client.substring(0, 16) : '?';
    const version = typeof body.version === 'string' ? body.version.substring(0, 32) : '?';
    verbose(`[${session.id}] offer from ${client} ${version} (peer connections ${sessions.size})`);
    verbose(`[${session.id}] offer sdp:\n${offerSdp}`);

    try {
      const answerSdp = await withTimeout(createAnswer(session, offerSdp), LIMITS.answerTimeoutMs, 'answer timeout');
      session.negotiating = false;
      if (session.closed) {
        throw new Error('closed during negotiation: ' + session.closeReason);
      }
      session.connectTimer = setTimeout(() => {
        closeSession(session, `no direct connection within ${Math.round(LIMITS.connectTimeoutMs / 1000)} s`);
      }, LIMITS.connectTimeoutMs);
      scheduleIdleClose(session);
      verbose(`[${session.id}] answer created after ${Date.now() - session.createdAt} ms`);
      verbose(`[${session.id}] answer sdp:\n${answerSdp}`);
      res.json({ 'sdp': answerSdp, 'session': session.id });
    } catch (error) {
      session.negotiating = false;
      // Only the first line, shortened: parser errors must not put SDP content into the log
      const reason = String(error.message).split('\n')[0].substring(0, 120);
      node.warn(`p2p: [${session.id}] negotiation failed: ${reason}`);
      verbose(`[${session.id}] negotiation error: ${error.stack || error}`);
      closeSession(session, 'negotiation failed: ' + reason);
      reject(500, 'p2p_error');
    }
  }

  return {
    handleOffer: handleOffer,
    setServerConfig: setServerConfig,
    getDirectCount: getDirectCount,
    getTelemetry: getTelemetry,
    commitTelemetry: commitTelemetry,
    closeAll: closeAll,
    shutdown: shutdown
  };
}

module.exports = {
  createManager: createManager,
  loadWerift: loadWerift,
  getWeriftError: getWeriftError,
  LIMITS: LIMITS,
  // Exposed for test/p2p-test.js (the simulated app uses the same werift quirk handling)
  _prepareIceTransports: prepareIceTransports
};
