module.exports = function(RED) {
  // const https = require('https')
  // const axios = require('axios')
  // const fs = require('fs');

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
      console.log(`Question: ${title} - ${body}`)
    });

    const url = `/contrib-remote/answerQuestion/${node.id}/:questionId/:answer`;
    console.log(url);
    RED.httpNode.get(url, function(req,res) {
      console.log("questionId: " + req.params.questionId);
      console.log("answer: " + req.params.answer);

      console.log(node);
      console.log(node.send);
      const msg = {
          "_msgid": RED.util.generateId(),
          "payload": req.params.answer
      }
      node.send(msg);

      const responseData = {
        'status': 'OK'
      };
      res.json(responseData);
    });
  }

  RED.nodes.registerType("remote-question",RemotequestionNode);

}
