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
      const title = RED.util.evaluateNodeProperty(config.notificationTitle, config.notificationTitleType, node, msg);
      const body = RED.util.evaluateNodeProperty(config.notificationBody, config.notificationBodyType, node, msg);

      // Call API to send notification
      const httpsAgent = new https.Agent({
        ca: fs.readFileSync(__dirname + '/resources/ca.cer')
      });
      const axiosInstance = axios.create({ httpsAgent: httpsAgent });
      axiosInstance.post('https://api.noderedcomms.de/sendNotification', {
        'instancehash': node.confignode.instancehash,
        'instanceauth': node.confignode.instanceauth,
        'notificationtitle': title,
        'notificationbody': body
      })
      .then(response => {
        node.log(response.data);

        // Output status if configured so
        if ( config.output == 2 ) {
          msg.payload = true;
          node.send(msg);
        }
      })
      .catch((error) => {
        node.error("ERROR: " + error);

        // Output status if configured so
        if ( config.output == 2 ) {
          msg.payload = false;
          node.send(msg);
        }
      });

      // Output message if configured so
      if ( config.output == 1 ) {
        node.send(msg);
      }
    });
  }

  RED.nodes.registerType("remote-notification",RemoteNotificationNode);

}
