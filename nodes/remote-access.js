module.exports = function(RED) {
  const commons = require('./remote-commons');
  const child_process = require('child_process');
  const os = require("os");
  let sshprocess = undefined
  let statustext = ''
  let instanceIsBanned = false

  function startSSH(node, server, port) {
    try {
      node.log("starting ssh process");

      // Reset heartbeat status
      node.initialHeartbeatStatus = ''
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
      sshprocess = child_process.spawn("ssh", sshparameters);

      // Set serving.. if not working, the process will exit or close
      setStatus(node, {fill:"green",shape:"dot",text:"remote-access.status.serving"});
      node.serving = true

      // Attach to process events
      sshprocess.stdout.on('data', (data) => {
        logSSHBuffer(node, data, 'ssh process stdout');
      });

      sshprocess.stderr.on('data', (data) => {
        logSSHBuffer(node, data, 'ssh process stderr');
        if ( data.toString().includes('Connection timed out')) {
          node.error(`SSH connection timeout. Please check if port 22 is open for outgoing connections.`);
        }
      });

      sshprocess.on('close', (code, signal) => {
        if ( statustext !== "remote-access.status.heartbeaterror" ) {
          setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.stopped"});
        }
        node.serving = false
        node.log("ssh process stopped (close: " + code + " / " + signal + ")");
      });

      sshprocess.on('exit', (code, signal) => {
        if ( statustext !== "remote-access.status.heartbeaterror" ) {
          setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.stopped"});
        }
        node.serving = false
        node.log("ssh process stopped (exit: " + code + " / " + signal + ")");
      });

      sshprocess.on('error', (err) => {
        node.log("ssh process error:" + err.name + ": " + err.message);
      });

      node.on('close', function() {
        setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.stopping"});
        node.log("stopping ssh process");
        sshprocess.kill();
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
      statustext = options.text
    }
    node.status(options);
  }

  function requestInstanceSlot(node) {
    // Is this instance banned?
    if ( instanceIsBanned ) {
      return;
    }

    // Call API to retrive server and port.
    const axiosInstance = commons.createAxiosInstance();
    axiosInstance.post(`https://api-${node.confignode.server}/instanceSlotRequest`, {
      'instancehash': node.confignode.instancehash,
      'instanceauth': node.confignode.instanceauth,
      'protocol': node.confignode.protocol,
      'mountpath': RED.httpNode.mountpath,
      'version': commons.getNodeVersion()
    })
    .then(response => {
      // Start SSH
      const port = response.data.port;
      node.log(`Using ${node.confignode.server} on port ${port}`);
      startSSH(node, node.confignode.server, port);
    })
    .catch((error) => {
      // Log error
      node.error('requestInstanceSlot: ' + commons.getNetworkErrorString(error))
      if ( commons.getNetworkErrorCustomString(error) !== undefined) {
        node.error(commons.getNetworkErrorCustomString(error));
      }

      // Wenn gebannt -> Merken
      if ( error.response && error.response.status ) {
        if ( error.response.status === 403 ) {
          setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.banned"});
          instanceIsBanned = true;
          return;
        }
      }

      // Set status
      setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.commerror"});
      return;
    });
  }

  function tryConnect(node) {
    // Request new instance slot and connect ssh
    requestInstanceSlot(node)

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
        if ( node.initialHeartbeatStatus === '' ) {
          node.initialHeartbeatStatus = response.data.status
        }
        node.lastHeartbeatStatus = response.data.status

        // If the communication is not ok...
        if ( node.lastHeartbeatStatus === 'NOTFOUND' ) {
          // The local endpoint responed a 404...
          setStatus(node, {fill:"yellow",shape:"dot",text:"remote-access.status.heartbeaterrornotfound"});
          node.log(`Heartbeat detected no valid endpoint, got a 404 response. Please check the base URL in the connection settings.`);
        } else if ( node.lastHeartbeatStatus !== 'OK' ) {
          if ( node.initialHeartbeatStatus === 'OK' ) {
            // If the status before was ok > Restart communication
            setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.heartbeaterror"});
            sshprocess.kill();
            node.serving = false
            node.log(`Heartbeat error. Reconnecting soon.`);
          } else {
            // If the status before had also an error > Just change the label.
            setStatus(node, {fill:"yellow",shape:"dot",text:"remote-access.status.heartbeaterroractive"});
            node.log(`Heartbeat detected no valid endpoint. Please check your connection settings (Base URL, Serving Port and Protocol).`);
          }
        }
      })
      .catch((error) => {
        // Error on api call > Log error
        node.error('heartbeat: ' + commons.getNetworkErrorString(error))
        if ( commons.getNetworkErrorCustomString(error) !== undefined) {
          node.error(commons.getNetworkErrorCustomString(error));
        }
      });
    }
  }

  function RemoteAccessNode(config) {
    RED.nodes.createNode(this,config);
    const node = this;
    node.serving = false;
    node.verbose = config.verbose;
    node.errorcounter = 0;

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
      node.log("Configuration has no instanceauth. Maybe restored backup!");
      setStatus(node, {fill:"red",shape:"dot",text:"remote-access.status.backupconfig"});
      return;
    }

    // Init heartbeat
    node.initialHeartbeatStatus = ''
    node.lastHeartbeatStatus = ''
    node.heartbeatinterval = setInterval(heartbeat, 5*60*1000, node);

    // Call API for announce the instacehash and authentication, retrive server and port.
    tryConnect(node);

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
    node.on('close', function() {
      // Cancel timeouts
      clearTimeout(node.checkservingtimeout);
      clearTimeout(node.tryconnecttimeout);
      clearInterval(node.heartbeatinterval);

      // Remove old routes, without a new deploy would break it..
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
    });

  }

  RED.nodes.registerType("remote-access",RemoteAccessNode);

}
