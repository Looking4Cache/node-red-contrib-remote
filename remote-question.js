module.exports = function(RED) {
  const commons = require('./remote-commons');

  function RemotequestionNode(config) {
    RED.nodes.createNode(this,config);
    const node = this;

    // Retrieve the config node
    node.confignode = RED.nodes.getNode(config.confignode);
    if ( this.confignode == undefined ) {
      node.log("No configuration found.");
    }

    node.on('input', function(msg) {
      const title = RED.util.evaluateNodeProperty(config.questionTitle, config.questionTitleType, node, msg);
      const body = RED.util.evaluateNodeProperty(config.questionBody, config.questionBodyType, node, msg);
      node.log(`Send question: ${title} - ${body}`)

      let questionData = {
        "instancehash": node.confignode.instancehash,
        "nodeid": node.id,
        "questiontype" : 1,
        "answers": [
          {
            "text": RED.util.evaluateNodeProperty(config.questionAnswerOne, config.questionAnswerOneType, node, msg),
            "value": RED.util.evaluateNodeProperty(config.questionAnswerOneValue, config.questionAnswerOneValueType, node, msg)
          },
          {
            "text": RED.util.evaluateNodeProperty(config.questionAnswerTwo, config.questionAnswerTwoType, node, msg),
            "value": RED.util.evaluateNodeProperty(config.questionAnswerTwoValue, config.questionAnswerTwoValueType, node, msg)
          },
          {
            "text": RED.util.evaluateNodeProperty(config.questionAnswerThree, config.questionAnswerThreeType, node, msg),
            "value": RED.util.evaluateNodeProperty(config.questionAnswerThreeValue, config.questionAnswerThreeValueType, node, msg)
          }
        ]
      };

      // Call API to send notification
      const axiosInstance = commons.createAxiosInstance();
      axiosInstance.post(`https://api-${node.confignode.server}/sendNotification`, {
        'instancehash': node.confignode.instancehash,
        'instanceauth': node.confignode.instanceauth,
        'notificationtitle': title,
        'notificationbody': body,
        'notificationsound': config.questionSound,
        'questiondata': JSON.stringify(questionData)
      })
      .then(response => {
        node.debug(`Question send successfull`)
      })
      .catch((error) => {
        node.error("ERROR: " + error);

        // Output Error
        const msg = {
            "_msgid": RED.util.generateId(),
            "payload": -1
        }
        node.send(msg);
      });
    });

    const postUrl = `/contrib-remote/answerQuestion/${node.id}`;
    RED.httpNode.post(postUrl, function(req,res) {
      // Output answer as new message
      node.log('Answer received: ' + req.body.answer);
      const msg = {
          //"_msgid": RED.util.generateId(),
          "payload": req.body.answer
      }
      node.send(msg);

      // Send OK to app
      const responseData = {
        'status': 'OK'
      };
      res.json(responseData);
    });

  }

  RED.nodes.registerType("remote-question",RemotequestionNode);

}
