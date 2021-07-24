module.exports = function(RED) {
  const commons = require('./remote-commons');
  const child_process = require('child_process');
  const os = require("os");

  function startSSH(node, server, port) {
    try {
      node.log("starting ssh process");
      let host = node.confignode.host;
      if ( host === 'localhost' && os.platform() === 'win32' ) {
        host = '127.0.0.1'
      }
      //node.log('ssh -o StrictHostKeyChecking=no -R ' + port.toString() + ':' + host + ':' + node.confignode.port.toString() + ' forward@proxy-' + server + ' -N');
      var sshparameters = ['-o StrictHostKeyChecking=no', '-R', port.toString() + ':' + host + ':' + node.confignode.port.toString(), 'forward@proxy-' + server, '-N'];
      if ( node.verbose ) {
        sshparameters.push('-v');
      }
      const sshprocess = child_process.spawn("ssh", sshparameters);

      // Set serving.. if not working, the process will exit or close
      node.status({fill:"green",shape:"dot",text:"remote-access.status.serving"});
      node.serving = true

      // Attach to process events
      sshprocess.stdout.on('data', (data) => {
        logSSHBuffer(node, data, 'ssh process stdout');
      });

      sshprocess.stderr.on('data', (data) => {
        logSSHBuffer(node, data, 'ssh process stderr');
      });

      sshprocess.on('close', (code, signal) => {
        node.status({fill:"red",shape:"dot",text:"remote-access.status.stopped"});
        node.serving = false
        node.log("ssh process stopped (close: " + code + " / " + signal + ")");
      });

      sshprocess.on('exit', (code, signal) => {
        node.status({fill:"red",shape:"dot",text:"remote-access.status.stopped"});
        node.serving = false
        node.log("ssh process stopped (exit: " + code + " / " + signal + ")");
      });

      sshprocess.on('error', (err) => {
        node.log("ssh process error:" + err.name + ": " + err.message);
      });

      node.on('close', function() {
        node.status({fill:"red",shape:"dot",text:"remote-access.status.stopping"});
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

  function requestInstanceSlot(node) {
    // Call API to retrive server and port.
    const axiosInstance = commons.createAxiosInstance();
    axiosInstance.post(`https://api-${node.confignode.server}/instanceSlotRequest`, {
      "instancehash": node.confignode.instancehash,
      "instanceauth": node.confignode.instanceauth,
      "protocol": node.confignode.protocol,
      "mountpath": RED.httpNode.mountpath
    })
    .then(response => {
      // Start SSH
      const port = response.data.port;
      node.log(`Using ${node.confignode.server} on port ${port}`);
      startSSH(node, node.confignode.server, port);
    })
    .catch((error) => {
      node.error('requestInstanceSlot: ' + error);
      if ( error.response && error.response.data && error.response.data.message ) {
        node.error(`${error.response.data.message}`);
      }
      node.status({fill:"red",shape:"dot",text:"remote-access.status.commerror"});
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

  function RemoteAccessNode(config) {
    RED.nodes.createNode(this,config);
    const node = this;
    node.serving = false;
    node.verbose = config.verbose;
    node.errorcounter = 0;

    // Status
    node.status({fill:"orange",shape:"dot",text:"remote-access.status.starting"});

    // Retrieve the config node
    node.confignode = RED.nodes.getNode(config.confignode);
    if ( node.confignode ) {
      node.log("Server: " + node.confignode.server + " InstanceHash: " + node.confignode.instancehash );
    } else {
      node.log("No configuration found.");
      node.status({fill:"red",shape:"dot",text:"remote-access.status.noconfig"});
      return;
    }
    if ( node.confignode.instancehash === undefined || node.confignode.instancehash === '' ) {
      node.log("Configuration incomplete.");
      node.status({fill:"red",shape:"dot",text:"remote-access.status.incompleteconfig"});
      return;
    }
    if ( node.confignode.instancehash !== undefined && node.confignode.instanceauth === undefined ) {
      node.log("Configuration has no instanceauth. Maybe restored backup!");
      node.status({fill:"red",shape:"dot",text:"remote-access.status.backupconfig"});
      return;
    }

    // Call API for announce the instacehash and authentication, retrive server and port.
    tryConnect(node);

    // Post URL for action
    const postUrl = `/contrib-remote/action/${node.confignode.instancehash}`;
    RED.httpNode.post(postUrl, function(req,res) {
      // Output action as new message
      node.log(`Action '${req.body.action}' received value '${req.body.value}'`);
      const msg = {
          "_msgid": RED.util.generateId(),
          "payload": {
            "action": req.body.action,
            "value": req.body.value
          }
      }
      node.send(msg);

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

      // Remove old routes, without a new deploy would break it..
      RED.httpNode._router.stack.forEach(function(route,i,routes) {
        if (route.route && (route.route.path === postUrl || route.route.path === getUrl)) {
          routes.splice(i,1);
        }
      });
    });

  }

  RED.nodes.registerType("remote-access",RemoteAccessNode);

}
