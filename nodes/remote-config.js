module.exports = function(RED) {
  const commons = require('./remote-commons');
  const internalIp = require('internal-ip');
  const fs = require('fs');
  var QRCode = require('qrcode');

  function RemoteConfigNode(n) {
    RED.nodes.createNode(this,n);
    this.name = n.name;
    this.host = n.host;
    this.protocol = n.protocol;
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

  RED.httpAdmin.get("/contrib-remote/connectionData", RED.auth.needsPermission('remote-config.read'), function(req,res) {
    // Return the internal IP and the mountpath
    const ipData = {
      'ipv4': internalIp.v4.sync(),
      'baseurl': RED.httpNode.mountpath + ((RED.settings.ui !== undefined && RED.settings.ui.path !== undefined) ? RED.settings.ui.path : 'ui'),
      'port': (RED.settings.uiPort !== undefined) ? String(RED.settings.uiPort) : '1880'
    }
    console.log(`${JSON.stringify(ipData)}`);
    res.json(ipData);
  });

  RED.httpAdmin.get("/contrib-remote/requestInstanceHash/:regionorserver", RED.auth.needsPermission('remote-config.read'), function(req,res) {
    // Call API for a instacehash and a instanceauth
    const axiosInstance = commons.createAxiosInstance();

    // Region or server?
    let url = '';
    if (req.params.regionorserver.includes('.')) {
      // server
      url = 'https://api-' + req.params.regionorserver + '/instanceHashRequest';
    } else {
      // region
      url = 'https://contact-' + req.params.regionorserver + '.remote-red.com/instanceHashRequest';
    }

    // Call API
    axiosInstance.post(url, {})
    .then(response => {
      res.json(response.data);
    })
    .catch((error) => {
      console.log("ERROR: requestInstanceHash: " + error);
      console.error(error);
      let errorMessage = error.message;
      if ( error.response && error.response.data && error.response.data.message ) {
        errorMessage = errorMessage + " / " + error.response.data.message;
      }
      if ( commons.getNetworkErrorCustomString(error) !== undefined) {
        errorMessage = commons.getNetworkErrorCustomString(error);
      }
      res.json({ 'error': errorMessage });
    });
  });

  RED.httpAdmin.post("/contrib-remote/registerApp", RED.auth.needsPermission('remote-config.read'), function(req,res) {
    // Call API for a appHash and password
    const axiosInstance = commons.createAxiosInstance();
    axiosInstance.post(`https://api-${req.body.server}/registerApp`, {
      'instancehash': req.body.instancehash,
      'instanceauth': req.body.instanceauth,
      'customerhash': req.body.customerhash
    })
    .then(response => {
      var localip = req.body.host;
      if (localip.toLowerCase() == 'localhost') {
        localip = internalIp.v4.sync();
      }
      if (localip === undefined) {
        localip = "";
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
      const link = 'remotered://add?data=' + qrCodeStringBase64;
      QRCode.toDataURL(qrCodeStringBase64, function (err, url) {
        const responseData = {
          'qrcode': url,
          'link': link
        }
        res.json(responseData);
      });
    })
    .catch((error) => {
      console.log("ERROR: registerApp: " + error);
      console.error(error);
      let errorMessage = error.message;
      if ( error.response && error.response.data && error.response.data.message ) {
        errorMessage = errorMessage + " / " + error.response.data.message;
      }
      if ( commons.getNetworkErrorCustomString(error) !== undefined) {
        errorMessage = commons.getNetworkErrorCustomString(error);
      }
      res.json({ 'error': errorMessage });
    });
  });

  RED.httpAdmin.get("/contrib-remote/getResouceFile/:filename", RED.auth.needsPermission('remote-config.read'), function(req,res) {
    // Sends a file as Base64
    const fileBase64 = fs.readFileSync(__dirname + '/resources/' + req.params.filename, {encoding: 'base64'});
    res.json({ 'filedata': fileBase64 });
  });

}
