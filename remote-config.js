module.exports = function(RED) {
  const https = require('https')
  const axios = require('axios')
  const fs = require('fs');
  var QRCode = require('qrcode');

  function RemoteConfigNode(n) {
    RED.nodes.createNode(this,n);

    this.name = n.name;
    this.instancehash = n.instancehash;
    this.instanceauth = this.credentials.instanceauth;
  }

  RED.nodes.registerType("remote-config",RemoteConfigNode, {
    credentials: {
      instanceauth: {type:"text"}
    }
  });

  RED.httpAdmin.get("/contrib-remote/requestInstanceHash", RED.auth.needsPermission('remote-config.read'), function(req,res) {
    // Call API for a instacehash and a instanceauth
    const httpsAgent = new https.Agent({
      ca: fs.readFileSync(__dirname + '/resources/ca.cer')
    });
    const axiosInstance = axios.create({ httpsAgent: httpsAgent });
    axiosInstance.post('https://api.noderedcomms.de/instanceHashRequest', {})
    .then(response => {
      console.log(response.data);
      res.json(response.data);
    })
    .catch((error) => {
      console.log("ERROR: " + error);
    });
  });

  RED.httpAdmin.get("/contrib-remote/registerApp/:instancehash/:instanceauth/:name", RED.auth.needsPermission('remote-config.read'), function(req,res) {
    // Call API for a instacehash and a instanceauth
    const httpsAgent = new https.Agent({
      ca: fs.readFileSync(__dirname + '/resources/ca.cer')
    });
    const axiosInstance = axios.create({ httpsAgent: httpsAgent });
    axiosInstance.post('https://api.noderedcomms.de/registerApp', {
      'instancehash': req.params.instancehash,
      'instanceauth': req.params.instanceauth
    })
    .then(response => {
      console.log(response.data);
      const qrCodeData = {
        'name': req.params.name,
        'instancehash': response.data.instancehash,
        'apphash': response.data.apphash,
        'password': response.data.password,
        'server': response.data.server,
        'nodeversion': 1.0
      };
      const qrCodeString = JSON.stringify(qrCodeData);
      console.log(qrCodeString);
      QRCode.toDataURL(qrCodeString, function (err, url) {
        const responseData = {
          'qrcode': url
        }
        res.json(responseData);
      });
    })
    .catch((error) => {
      console.log("ERROR: " + error);
    });
  });

}
