module.exports = function(RED) {
  const commons = require('./remote-commons');
  const child_process = require('child_process');
  const os = require("os");
  const internalIp = require('internal-ip');
  const instancehashToAccessNode = {};

  async function startSSH(node, server, port) {
    try {
      node.log("starting ssh process");

      // Is there a old node.sshprocess object?
      if (node.sshprocess !== undefined) {
        node.log(`checking old ssh process with pid ${node.sshprocess.pid}`);
        await killSSHProcess(node);
      }

      // Reset heartbeat status for current tunnel
      node.lastHeartbeatStatus = ''

      // Create ssh command
      let host = node.confignode.host;
      if ( host === 'localhost' && os.platform() === 'win32' ) {
        host = '127.0.0.1'
      }
      // node.log('ssh -o StrictHostKeyChecking=no -R ' + port.toString() + ':' + host + ':' + node.confignode.port.toString() + ' forward@proxy-' + server + ' -N');
      var sshparameters = ['-o StrictHostKeyChecking=no', '-R', port.toString() + ':' + host + ':' + node.confignode.port.toString(), 'forward@proxy-' + server, '-N'];
      if ( node.verbose ) {
        sshparameters.push('-v');
      }
      node.sshprocess = child_process.spawn("ssh", sshparameters);
      const currentPid = node.sshprocess.pid;
      node.log(`ssh process with pid ${currentPid} started`);

      // Set serving.. if not working, the process will exit or close
      setStatus(node, {fill:"green",shape:"dot",text:"remote-access.status.serving"});
      node.serving = true

      // Attach to process events
      node.sshprocess.stdout.on('data', (data) => {
        logSSHBuffer(node, data, 'ssh process stdout');
      });

      node.sshprocess.stderr.on('data', (data) => {
        logSSHBuffer(node, data, 'ssh process stderr');
        if ( data.toString().includes('Connection timed out')) {
          node.error(`SSH connection timeout. Please check if port 22 is open for outgoing connections.`);
        }
      });

      node.sshprocess.on('close', (code, signal) => {
        node.log(`ssh process close (pid: ${currentPid} code: ${code} signal: ${signal})`);
        // Only update status if this is still the current process
        if (node.sshprocess && node.sshprocess.pid === currentPid) {
          if ( node.statustext !== "remote-access.status.heartbeaterror" ) {
            setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.stopped"});
          }
          node.serving = false
        }
      });

      node.sshprocess.on('exit', (code, signal) => {
        node.log(`ssh process exit (pid: ${currentPid} code: ${code} signal: ${signal})`);
        // Only update status if this is still the current process
        if (node.sshprocess && node.sshprocess.pid === currentPid) {
          if ( node.statustext !== "remote-access.status.heartbeaterror" ) {
            setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.stopped"});
          }
          node.serving = false
        }
      });

      node.sshprocess.on('error', (err) => {
        node.log(`ssh process error (pid: ${currentPid}): ${err.name} : ${err.message}`);
      });
    } catch (e) {
      // TODO: Error: socket hang up
      node.error('startSSH error: ' + error);
    }
  }

  function logSSHBuffer(node, data, prefix) {
    // Logs the output from the ssh process if enabled
    if ( node.verbose ) {
      data.toString().split('\n').forEach(function(line) {
        if ( line !== '' ) {
          node.log(prefix + ': ' + line)
        }
      });
    }
  }

  function setStatus(node, options) {
    // Set the status, remember text
    if ( options !== undefined && options.text !== undefined ) {
      node.statustext = options.text
    }
    node.status(options);
  }

  function requestInstanceSlot(node) {
    // Asnyc because https call can take some seconds..
    return new Promise((resolve, reject) => {
      // Is this instance banned?
      if ( node.instanceIsBanned ) {
        reject(new Error('Instance banned'));
        return;
      }

      // Create object with config values to send to server
      var localip = node.confignode.host;
      if (localip.toLowerCase() == 'localhost') localip = internalIp.v4.sync();
      if (localip === undefined) localip = "";
      const config = {
        'name': node.confignode.name,
        'localip': localip,
        'localport': node.confignode.port,
        'localprotocol': node.confignode.protocol,
        'baseurl': node.confignode.baseurl,
        'timestamp': Date.now(),
      }
      const configString = JSON.stringify(config);
      const configStringBuffer = Buffer.from(configString);
      const configStringBase64 = configStringBuffer.toString('base64');
      // node.log(`Sending config to server: ${configString}`);

      // Call API to retrive server and port.
      const axiosInstance = commons.createAxiosInstance();
      axiosInstance.post(`https://api-${node.confignode.server}/instanceSlotRequest`, {
        'instancehash': node.confignode.instancehash,
        'instanceauth': node.confignode.instanceauth,
        'protocol': node.confignode.protocol,
        'mountpath': RED.httpNode.mountpath,
        'config': configStringBase64,
        'version': commons.getNodeVersion()
      })
      .then(response => {
        // Start SSH
        const port = response.data.port;
        node.log(`Using ${node.confignode.server} on port ${port}`);
        startSSH(node, node.confignode.server, port);
        resolve();
      })
      .catch((error) => {
        // Log error
        node.error('requestInstanceSlot: ' + commons.getNetworkErrorString(error));
        node.error(error);
        if ( commons.getNetworkErrorCustomString(error) !== undefined) {
          node.error(commons.getNetworkErrorCustomString(error));
        }
        commons.reportError(error, node, 'requestInstanceSlot');

        // Wenn gebannt -> Merken
        if ( error.response && error.response.status ) {
          if ( error.response.status === 403 ) {
            setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.banned"});
            node.instanceIsBanned = true;
            reject(new Error('Instance banned'));
            return;
          }
        }

        // Set status
        if (!node.instanceIsBanned) setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.commerror"});

        // Resolve as error is handled
        resolve();
      });
    });
  }

  async function tryConnect(node) {
    // Request new instance slot and connect ssh
    try {
      await requestInstanceSlot(node)
    } catch (error) {
      commons.reportError(error, node, 'tryConnect');
    }

    // Create timer to check if ssh process still serving in 10 seconds
    node.checkservingtimeout = setTimeout(checkServing, 1000*10, node);
  }

  function checkServing(node) {
    // Test if ssh serving
    if ( !node.serving ) {
      // Increase error counter
      node.errorcounter++;

      // Start timer to reconnect
      let interval = 1000*10;
      if (node.errorcounter >= 8) {
        interval = 1000*290;
      } else if (node.errorcounter >= 4) {
        interval = 1000*50;
      }
      node.tryconnecttimeout = setTimeout(tryConnect, interval, node);
    } else {
      // Running > Reset error counter
      node.errorcounter = 0;

      // Schedule timer to check if still serving
      node.checkservingtimeout = setTimeout(checkServing, 1000*10, node);
    }
  }

  function heartbeat(node) {
    // Performs a heartbeat: Ask to the server if ssh is available
    if ( node.serving ) {
      const axiosInstance = commons.createAxiosInstance();
      axiosInstance.post(`https://api-${node.confignode.server}/heartbeat`, {
        'instancehash': node.confignode.instancehash,
        'instanceauth': node.confignode.instanceauth,
        'version': commons.getNodeVersion()
      }, {
        'timeout': 60*1000
      })
      .then(response => {
        // Remember the status
        node.lastHeartbeatStatus = response.data.status

        // Based on the status...
        if ( node.lastHeartbeatStatus === 'OK' ) {
          // Successful heartbeat
          node.configurationValidated = true;   // Configuration is definitely OK
          node.initialRetryCount = 0;           // Reset retry counter on success
          setStatus(node, {fill:"green",shape:"dot",text:"remote-access.status.serving"});
        } else if ( node.lastHeartbeatStatus === 'NOTFOUND' ) {
          // The local endpoint responded with a 404...
          setStatus(node, {fill:"yellow",shape:"dot",text:"remote-access.status.heartbeaterrornotfound"});
          node.log(`Heartbeat detected no valid endpoint, got a 404 response. Please check the base URL in the connection settings.`);
        } else {
          // Heartbeat error - decide whether to reconnect
          if ( node.configurationValidated === true ) {
            // Configuration was validated before → Reconnect
            setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.heartbeaterror"});
            node.log(`Heartbeat error. Reconnecting soon.`);
            // Set serving to false, checkServing will trigger reconnect and startSSH will kill old process
            node.serving = false;
          } else {
            // Never worked yet - check if still in startup phase
            if ( node.initialRetryCount < 3 ) {
              // Still in startup phase - give it more chances (after reboot with slow network, Starlink reconnect, etc.)
              node.initialRetryCount++;
              setStatus(node, {fill:"yellow",shape:"dot",text:"remote-access.status.heartbeaterror"});
              node.log(`Heartbeat error during startup (attempt ${node.initialRetryCount}/3). Reconnecting soon.`);
              node.serving = false;  // Trigger reconnect
            } else {
              // Too many failed attempts > Misconfiguration > NO reconnect
              setStatus(node, {fill:"yellow",shape:"dot",text:"remote-access.status.heartbeaterroractive"});
              node.log(`Heartbeat detected no valid endpoint. Please check your connection settings (Base URL, Serving Port and Protocol).`);
            }
          }
        }
      })
      .catch((error) => {
        // Error on api call > Log error
        commons.reportError(error, node, 'heartbeat');
        if ( commons.getNetworkErrorCustomString(error) !== undefined) {
          node.error(commons.getNetworkErrorCustomString(error));
        }
      });
    }
  }

  function killSSHProcess(node) {
    // Returns a promise that kills the current process. Resolves when process is dead or after 2 seconds.
    return new Promise((resolve) => {
      try {
        if (node.sshprocess !== undefined) {
          const pidToKill = node.sshprocess.pid;
          const processToKill = node.sshprocess;

          // Remove existing listeners
          processToKill.removeAllListeners('close');
          processToKill.removeAllListeners('exit');
          processToKill.removeAllListeners('error');
          processToKill.stdout.removeAllListeners('data');
          processToKill.stderr.removeAllListeners('data');

          // Check if process is already dead (exitCode is set when process has exited)
          if (processToKill.exitCode !== null || processToKill.killed) {
            node.log(`Process ${pidToKill} already dead (exitCode: ${processToKill.exitCode}, killed: ${processToKill.killed})`);
            node.sshprocess = undefined;
            node.serving = false;
            resolve();
            return;
          }

          node.log(`Killing process ${pidToKill}`);

          // Safety timeout: resolve after 2 seconds even if exit event doesn't fire
          const safetyTimeout = setTimeout(() => {
            node.log(`Process ${pidToKill} kill timeout after 2 seconds`);
            node.serving = false;
            resolve();
          }, 2000);

          // Set up one-time exit handler to know when process is really dead
          const exitHandler = () => {
            clearTimeout(safetyTimeout);
            node.log(`Process ${pidToKill} confirmed killed`);
            node.serving = false;
            resolve();
          };

          // Add one-time exit handler
          processToKill.once('exit', exitHandler);

          // Send kill signal
          processToKill.kill();
          node.sshprocess = undefined;
        } else {
          node.serving = false;
          resolve();
        }
      } catch (error) {
        node.error(`Error in killSSHProcess: ${error}`);
        node.serving = false;
        resolve();
      }
    });
  }

  function RemoteAccessNode(config) {
    RED.nodes.createNode(this,config);
    const node = this;
    node.sshprocess = undefined;
    node.statustext = '';
    node.serving = false;
    node.verbose = config.verbose;
    node.errorcounter = 0;
    node.instanceIsBanned = false;

    // Status
    setStatus(node, {fill:"orange",shape:"dot",text:"remote-access.status.starting"});

    // Retrieve the config node
    node.confignode = RED.nodes.getNode(config.confignode);
    if ( node.confignode ) {
      node.log("Server: " + node.confignode.server + " InstanceHash: " + node.confignode.instancehash );
    } else {
      node.log("No configuration found.");
      setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.noconfig"});
      return;
    }
    if ( node.confignode.instancehash === undefined || node.confignode.instancehash === '' ) {
      node.log("Configuration incomplete.");
      setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.incompleteconfig"});
      return;
    }
    if ( node.confignode.instancehash !== undefined && node.confignode.instanceauth === undefined ) {
      node.error("Configuration has no instanceauth. Maybe restored backup!");
      setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.backupconfig"});
      return;
    }

    // Check if there are more access nodes for this config node
    const accessNodeObject = instancehashToAccessNode[node.confignode.instancehash];
    if (accessNodeObject !== undefined && accessNodeObject['id'] !== node.id) {
      const errorText = `The config node '${node.confignode.name}' is already used in the access node '${accessNodeObject['name']}'. Use only one access node for a config node.`;
      node.error(errorText);
      setStatus(node, {fill:"red",shape:"dot",text:errorText});
      return;
    } else {
      instancehashToAccessNode[node.confignode.instancehash] = { id: node.id, name: node.name }
    }
        
    // Init heartbeat
    node.configurationValidated = false;  // Was the configuration EVER successfully validated?
    node.lastHeartbeatStatus = '';
    node.initialRetryCount = 0;           // Counts retry attempts during startup phase
    node.heartbeatinterval = setInterval(heartbeat, 5*60*1000, node);

    // Call API for announce the instacehash and authentication, retrive server and port.
    tryConnect(node)

    // Post URL for action
    const postUrlAction = `/contrib-remote/action/${node.confignode.instancehash}`;
    RED.httpNode.post(postUrlAction, function(req,res) {
      // Output action as new message
      node.log(`Action '${req.body.action}' received value '${req.body.value}'`);
      const msg = {
          "_msgid": RED.util.generateId(),
          "payload": {
            "action": req.body.action,
            "value": req.body.value
          }
      }
      node.send([msg, null]);

      // Send OK to app
      const responseData = {
        'status': 'OK'
      };
      res.json(responseData);
    });

    // Post URL for geofence
    const postUrlGeofence = `/contrib-remote/geofence/${node.confignode.instancehash}`;
    RED.httpNode.post(postUrlGeofence, function(req,res) {
      // Output action as new message
      node.log(`Geofence '${req.body.name}' received enter value '${req.body.enter}'`);
      const msg = {
          "_msgid": RED.util.generateId(),
          "payload": {
            "name": req.body.name,
            "enter": req.body.enter
          }
      }
      node.send([null, msg]);

      // Send OK to app
      const responseData = {
        'status': 'OK'
      };
      res.json(responseData);
    });

    // Get URL for action (get context variables)
    const getUrl = `/contrib-remote/context/${node.confignode.instancehash}/:context/:value`;
    RED.httpNode.get(getUrl, function(req,res) {
      // Get the vaue from the context and return it
      const value = RED.util.evaluateNodeProperty(req.params.value, req.params.context, node, "");
      const contextData = {
        'value': value
      }
      res.json(contextData);
    });

    // Clean up on close
    node.on('close', function(removed, done) {
      // Set status
      setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.stopping"});

      // Kill process (don't wait as Node-RED has a timeout for close handlers)
      killSSHProcess(node).catch(err => node.error(`Error killing SSH process on close: ${err}`))

      // Cancel timeouts
      try {
        clearTimeout(node.checkservingtimeout);
        clearTimeout(node.tryconnecttimeout);
        clearInterval(node.heartbeatinterval);
      } catch (error) {
        node.error(`Error in close > clearTimeout: ${error}`);
      }

      // Remove old routes, without a new deploy would break it..
      try {
        RED.httpNode._router.stack.forEach(function(route,i,routes) {
          if (route.route && route.route.path === postUrlAction) {
            node.log(` -> Remove Route '${route.route.path}'`);
            routes.splice(i,1);
          }
        });
        RED.httpNode._router.stack.forEach(function(route,i,routes) {
          if (route.route && route.route.path === postUrlGeofence) {
            node.log(` -> Remove Route '${route.route.path}'`);
            routes.splice(i,1);
          }
        });
        RED.httpNode._router.stack.forEach(function(route,i,routes) {
          if (route.route && route.route.path === getUrl) {
            node.log(` -> Remove Route '${route.route.path}'`);
            routes.splice(i,1);
          }
        });
      } catch (error) {
        node.error(`Error in close > remove routs: ${error}`);
      }

      // Signal close done
      done();
    });

  }

  RED.nodes.registerType("remote-access",RemoteAccessNode);

}
