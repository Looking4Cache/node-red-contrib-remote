module.exports = function(RED) {
  const https = require('https')
  const axios = require('axios')
  const fs = require('fs');

  function RemoteNotificationNode(config) {
    RED.nodes.createNode(this,config);
    const node = this;

    // Retrieve the config node
    node.confignode = RED.nodes.getNode(config.confignode);
    if ( this.confignode == undefined ) {
      node.log("No configuration found.");
    }

    node.on('input', function(msg) {
      // Call API to send notification
      const httpsAgent = new https.Agent({
        ca: fs.readFileSync(__dirname + '/resources/ca.cer')
      });
      const axiosInstance = axios.create({ httpsAgent: httpsAgent });
      axiosInstance.post('https://api.noderedcomms.de/sendNotification', {
        'instancehash': node.confignode.instancehash,
        'instanceauth': node.confignode.instanceauth,
        'notificationtitle': msg.payload,
        'notificationbody': ''
      })
      .then(response => {
        node.log(response.data);
      })
      .catch((error) => {
        node.error("ERROR: " + error);
      });

      // msg.payload = msg.payload.toLowerCase();
      node.send(msg);
    });
  }

  RED.nodes.registerType("remote-notification",RemoteNotificationNode);

}
