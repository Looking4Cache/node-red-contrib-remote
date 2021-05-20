module.exports = function(RED) {
  const commons = require('./remote-commons');
  const RateLimiter = require('limiter').RateLimiter;

  function RemoteNotificationNode(config) {
    RED.nodes.createNode(this,config);
    const node = this;

    // Retrieve the config node
    node.confignode = RED.nodes.getNode(config.confignode);
    if (node.confignode == undefined) {
      node.log("No configuration found.");
    }

    // Init limiter for notifications
    node.limiter = new RateLimiter(100, 'hour', true);

    // Act on incomming messages
    node.on('input', function(msg) {
      if (node.confignode != undefined) {
        node.limiter.removeTokens(1, function(err, remainingRequests) {
          if (remainingRequests >= 0) {
            const title = RED.util.evaluateNodeProperty(config.notificationTitle, config.notificationTitleType, node, msg);
            const body = RED.util.evaluateNodeProperty(config.notificationBody, config.notificationBodyType, node, msg);
            node.log(`Send notication: ${title} - ${body}`)

            // Call API to send notification
            const axiosInstance = commons.createAxiosInstance();
            axiosInstance.post(`https://api-${node.confignode.server}/sendNotification`, {
              'instancehash': node.confignode.instancehash,
              'instanceauth': node.confignode.instanceauth,
              'notificationtitle': title,
              'notificationbody': body,
              'notificationsound': config.notificationSound
            })
            .then(response => {
              node.debug(`Notication send successfull`)

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
          } else {
            // Limit reached
            node.error("Notifications limit reached! (100 notifications/hour/node)");

            // Output status if configured so
            if ( config.output == 2 ) {
              msg.payload = false;
              node.send(msg);
            }
          }

          // Output message if configured so
          if ( config.output == 1 ) {
            node.send(msg);
          }
        });
      } else {
        node.log("No configuration found.");
      }
    });
  }

  RED.nodes.registerType("remote-notification",RemoteNotificationNode);

}
