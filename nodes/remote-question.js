module.exports = function(RED) {
  const commons = require('./remote-commons');
  const RateLimiter = require('limiter').RateLimiter;

  function RemotequestionNode(config) {
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
        if (msg.payload !== undefined && msg.payload.send === false) {
          node.log(`Question not send (msg.payload.send = false).`)
          return;
        }
        node.limiter.removeTokens(1, function(err, remainingRequests) {
          if (remainingRequests >= 0) {
            let title = commons.evaluateValue(RED, config.questionTitle, config.questionTitleType, node, msg, true);
            let body = commons.evaluateValue(RED, config.questionBody, config.questionBodyType, node, msg, true);
            const notificationEmpty = (title == '' && body == '');
            if (!notificationEmpty) {
              // Title and/or body are filled, generate question data
              let questionData = {
                "instancehash": node.confignode.instancehash,
                "nodeid": node.id,
                "questiontype" : 1,
                "answers": [
                  {
                    "text": commons.evaluateValue(RED, config.questionAnswerOne, config.questionAnswerOneType, node, msg, true),
                    "value": commons.evaluateValue(RED, config.questionAnswerOneValue, config.questionAnswerOneValueType, node, msg, false)
                  },
                  {
                    "text": commons.evaluateValue(RED, config.questionAnswerTwo, config.questionAnswerTwoType, node, msg, true),
                    "value": commons.evaluateValue(RED, config.questionAnswerTwoValue, config.questionAnswerTwoValueType, node, msg, false)
                  },
                  {
                    "text": commons.evaluateValue(RED, config.questionAnswerThree, config.questionAnswerThreeType, node, msg, true),
                    "value": commons.evaluateValue(RED, config.questionAnswerThreeValue, config.questionAnswerThreeValueType, node, msg, false)
                  }
                ]
              };
              node.log(`questionData: ${JSON.stringify(questionData)}`)

              // Content smaller than 3600 bytes? FCM max size (complete payload) is 4000 bytes.
              if (title.length + body.length + JSON.stringify(questionData).length <= 3600) {
                // Log send
                node.log(`Send question: ${title} - ${body}`)

                // Sound configured or computed?
                let sound = config.questionSound
                if (sound === 'computed') {
                  sound = commons.evaluateValue(RED, config.questionSoundComputed, config.questionSoundComputedType, node, msg, true);
                }

                // Call API to send notification
                const axiosInstance = commons.createAxiosInstance();
                axiosInstance.post(`https://api-${node.confignode.server}/sendNotification`, {
                  'instancehash': node.confignode.instancehash,
                  'instanceauth': node.confignode.instanceauth,
                  'notificationtitle': title,
                  'notificationbody': body,
                  'notificationsound': sound,
                  'questiondata': JSON.stringify(questionData),
                  'version': commons.getNodeVersion()
                })
                .then(response => {
                  node.debug(`Question send successfull`)
                })
                .catch((error) => {
                  // Log error
                  node.error('sendNotification: ' + commons.getNetworkErrorString(error))
                  if ( commons.getNetworkErrorCustomString(error) !== undefined) {
                    node.error(commons.getNetworkErrorCustomString(error));
                  }

                  // Output Error
                  const msg = {
                      "_msgid": RED.util.generateId(),
                      "payload": -1
                  }
                  node.send(msg);
                });
              } else {
                // To big...
                node.error("The message exceeded 3600 bytes. Can´t send.");

                // Output status if configured so
                const msg = {
                    "_msgid": RED.util.generateId(),
                    "payload": -1
                }
                node.send(msg);
              }
            } else {
              // Title and Body are empty
              node.error("You tried to sent a question without a title and without a body.");

              // Output status if configured so
              const msg = {
                  "_msgid": RED.util.generateId(),
                  "payload": -1
              }
              node.send(msg);
            }
          } else {
            // Limit reached
            node.error("Questions limit reached! (100 questions/hour/node)");

            // Output Error
            const msg = {
                "_msgid": RED.util.generateId(),
                "payload": -1
            }
            node.send(msg);
          }
        });
      } else {
        node.log("No configuration found.");
      }
    });

    const postUrl = `/contrib-remote/answerQuestion/${node.id}`;
    RED.httpNode.post(postUrl, function(req,res) {
      // Output answer as new message
      node.log('Answer received: ' + req.body.answer);
      const msg = {
          "_msgid": RED.util.generateId(),
          "payload": req.body.answer
      }
      node.send(msg);

      // Send OK to app
      const responseData = {
        'status': 'OK'
      };
      res.json(responseData);
    });

    node.on('close', function() {
      // Remove old routes, without a new deploy would break it..
      RED.httpNode._router.stack.forEach(function(route,i,routes) {
        if (route.route && route.route.path === postUrl) {
          routes.splice(i,1);
        }
      });
    });

  }

  RED.nodes.registerType("remote-question",RemotequestionNode);

}
