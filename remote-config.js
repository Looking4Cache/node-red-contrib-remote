module.exports = function(RED) {
  const https = require('https')
  const axios = require('axios')
  const fs = require('fs');
  const internalIp = require('internal-ip');
  var QRCode = require('qrcode');

  function RemoteConfigNode(n) {
    RED.nodes.createNode(this,n);

    this.name = n.name;
    this.host = n.host;
    this.port = n.port;
    this.baseurl = n.baseurl;
    this.instancehash = n.instancehash;
    this.server = n.server;
    this.instanceauth = this.credentials.instanceauth;
    this.region = n.region;
  }

  RED.nodes.registerType("remote-config",RemoteConfigNode, {
    credentials: {
      instanceauth: {type:"text"}
    }
  });

  RED.httpAdmin.get("/contrib-remote/internalIpV4", RED.auth.needsPermission('remote-config.read'), function(req,res) {
    // Return the internal IP
    const ipData = {
      'ipv4': internalIp.v4.sync()
    }
    res.json(ipData);
  });

  RED.httpAdmin.get("/contrib-remote/requestInstanceHash/:region", RED.auth.needsPermission('remote-config.read'), function(req,res) {
    // Call API for a instacehash and a instanceauth
    const httpsAgent = new https.Agent({
      ca: fs.readFileSync(__dirname + '/resources/ca.cer')
    });
    const axiosInstance = axios.create({ httpsAgent: httpsAgent });
    axiosInstance.post('https://contact-' + req.params.region + '.remote-red.com/instanceHashRequest', {})
    .then(response => {
      console.log(response.data);
      res.json(response.data);
    })
    .catch((error) => {
      console.log("ERROR: requestInstanceHash: " + error);
      res.json({ 'error': error.message });
    });
  });

  RED.httpAdmin.post("/contrib-remote/registerApp", RED.auth.needsPermission('remote-config.read'), function(req,res) {
    // Call API for a instacehash and a instanceauth
    const httpsAgent = new https.Agent({
      ca: fs.readFileSync(__dirname + '/resources/ca.cer')
    });
    const axiosInstance = axios.create({ httpsAgent: httpsAgent });
    axiosInstance.post(`https://api-${req.body.server}/registerApp`, {
      'instancehash': req.body.instancehash,
      'instanceauth': req.body.instanceauth
    })
    .then(response => {
      console.log(response.data);

      var localip = req.body.host;
      if (localip.toLowerCase() == 'localhost') {
        localip = internalIp.v4.sync();
      }

      const qrCodeData = {
        'name': req.body.name,
        'server': req.body.server,
        'localip': localip,
        'localport': req.body.localport,
        'baseurl': req.body.baseurl,
        'instancehash': response.data.instancehash,
        'apphash': response.data.apphash,
        'password': response.data.password,
        'nodeversion': 1.0
      };
      const qrCodeString = JSON.stringify(qrCodeData);
      const qrCodeStringBuffer = Buffer.from(qrCodeString);
      const qrCodeStringBase64 = qrCodeStringBuffer.toString('base64');
      QRCode.toDataURL(qrCodeStringBase64, function (err, url) {
        const responseData = {
          'qrcode': url
        }
        res.json(responseData);
      });
    })
    .catch((error) => {
      console.log("ERROR: registerApp: " + error);
      res.json({ 'error': error.message });
    });
  });

}
