module.exports = function(RED) {
  const https = require('https')
  const axios = require('axios')
  const fs = require('fs');
  const child_process = require('child_process');

  function startSSH(node, server, port) {
    try {
      node.log("exec ssh");
      //node.log('ssh -o StrictHostKeyChecking=no -R ' + port.toString() + ':' + node.confignode.host + ':' + node.confignode.port.toString() + 'forward@proxy-' + server + ' -N');
      const sshprocess = child_process.spawn("ssh", ['-o StrictHostKeyChecking=no', '-R', port.toString() + ':' + node.confignode.host + ':' + node.confignode.port.toString(), 'forward@proxy-' + server, '-N']);

      // TODO: Herausfinden ob wirklich verbunden
      node.status({fill:"green",shape:"dot",text:"serving"});
      node.serving = true

      sshprocess.stdout.on('data', (data) => {
        node.log("ssh process stdout: " + data);
      });

      sshprocess.stderr.on('data', (data) => {
        node.log("ssh process stderr: " + data);
      });

      sshprocess.on('close', (code, signal) => {
        node.status({fill:"red",shape:"dot",text:"stopped"});
        node.serving = false
        node.log("ssh process stopped");
      });

      node.on('close', function() {
        node.status({fill:"red",shape:"dot",text:"stopping"});
        node.log("stopping ssh process");
        sshprocess.kill();
      });
    } catch (e) {
      // TODO: Error: socket hang up
      node.error('startSSH error: ' + error);
    }
  }

  function requestInstanceSlot(node) {
    // Call API to retrive server and port.
    const httpsAgent = new https.Agent({
      ca: fs.readFileSync(__dirname + '/resources/ca.cer')
    });
    const axiosInstance = axios.create({ httpsAgent: httpsAgent });
    axiosInstance.post(`https://api-${node.confignode.server}/instanceSlotRequest`, {
      "instancehash": node.confignode.instancehash
    })
    .then(response => {
      // Start SSH
      const port = response.data.port;
      node.log(`Using ${node.confignode.server} on port ${port}`);
      startSSH(node, node.confignode.server, port);
    })
    .catch((error) => {
      node.error('axios error: ' + error);
      node.status({fill:"red",shape:"dot",text:"Error communicating with server."});
      return;
    });
  }

  function servingTimer(node) {
    // Request new instance slot and connect ssh if not connected
    if (!node.serving) {
      requestInstanceSlot(node)
    }
  }

  function RemoteAccessNode(config) {
    RED.nodes.createNode(this,config);
    const node = this;
    node.serving = false;

    // Status
    node.status({fill:"orange",shape:"dot",text:"starting"});

    // Retrieve the config node
    node.confignode = RED.nodes.getNode(config.confignode);
    if ( node.confignode ) {
      node.log("this.confignode.name: " + node.confignode.name);
      node.log("this.confignode.instancehash: " + node.confignode.instancehash);
      node.log("this.confignode.server: " + node.confignode.server);
    } else {
      node.log("No configuration found.");
      node.status({fill:"red",shape:"dot",text:"No configuration found."});
      return;
    }
    if ( node.confignode.instancehash === undefined || node.confignode.instancehash === '' ) {
      node.log("Configuration incomplete.");
      node.status({fill:"red",shape:"dot",text:"Configuration incomplete."});
      return;
    }

    // Timeout for connection check
    node.servingInterval = setInterval(servingTimer, 1000*10, node);

    // Call API for announce the instacehash and authentication, retrive server and port.
    requestInstanceSlot(node);

    // Cleanup on close
    node.on('close', function() {
      clearInterval(node.servingInterval);
    });

    // node.log("this.credentials.installhash: " + this.credentials.installhash);
    // var installhash = this.credentials.installhash;
    // if ( installhash === undefined || installhash === '' ) {
    //  installhash = makeid(48)
    //  this.credentials.installhash = installhash
    //}
    //node.log("this.credentials.installhash: " + this.credentials.installhash);

    // this.status({fill:"green",shape:"dot",text:installhash});
  }

  RED.nodes.registerType("remote-access",RemoteAccessNode);

}
