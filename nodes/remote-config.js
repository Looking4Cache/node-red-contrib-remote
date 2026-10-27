module.exports = function(RED) {
  const commons = require('./remote-commons');
  const internalIp = require('internal-ip');
  const nettest = require('./remote-nettest');
  const fs = require('fs');
  const path = require('path');
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
    this.customerhash = n.customerhash;
    // Direct connection (WebRTC), existing config nodes without the field count as enabled
    this.p2p = (n.p2p === undefined) ? true : n.p2p;
  }

  RED.nodes.registerType("remote-config",RemoteConfigNode, {
    credentials: {
      instanceauth: {type:"text"}
    }
  });

  RED.httpAdmin.get("/contrib-remote/testNetwork", RED.auth.needsPermission('remote-config.read'), function(req,res) {
    // Connection test from the config node editor, checks see remote-nettest.js
    nettest.run(RED, req.query)
    .then(result => {
      res.json(result);
    })
    .catch((error) => {
      if ( error.status === undefined ) {
        console.log("ERROR: testNetwork: " + error);
        console.error(error);
      }
      res.status(error.status || 500).json({ 'error': error.message });
    });
  });

  RED.httpAdmin.get("/contrib-remote/connectionData", RED.auth.needsPermission('remote-config.read'), async function(req,res) {
    // Return the internal IP, the port, the protocol and the calculated baseurl
    const ipData = {
      ipv4: internalIp.v4.sync(),
      port: (RED.settings.uiPort !== undefined) ? String(RED.settings.uiPort) : '1880',
      protocol: (RED.settings.https !== undefined) ? 'https' : 'http',
    }

    // Check Dashbaord 2 url
    const availableDashbaord = await commons.testUrlAvailable(`${ipData.protocol}://${ipData.ipv4}:${ipData.port}${RED.httpNode.mountpath}dashboard`);
    if (availableDashbaord) {
      ipData.baseurl = `${RED.httpNode.mountpath}dashboard`;
    } else {
      // Dashbaord 2 not founnd, use UI settings instead
      ipData.baseurl =  RED.httpNode.mountpath + ((RED.settings.ui !== undefined && RED.settings.ui.path !== undefined) ? RED.settings.ui.path : 'ui');
    }

    // console.log(`${JSON.stringify(ipData)}`);
    res.json(ipData);
  });

  RED.httpAdmin.get("/contrib-remote/requestInstanceHash/:regionorserver/:customerhash/:customerkey", RED.auth.needsPermission('remote-config.read'), function(req,res) {
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

    // Build request body; customerreference is optional (query param, backwards compatible
    // with older CLI/node versions that never send it, PARTNER-PORTAL-KONZEPT Kap. 8.3 pt. 7)
    const postData = {
      'customerhash': req.params.customerhash,
      'customerkey': req.params.customerkey,
      'version': commons.getNodeVersion()
    };
    if (req.query.customerreference !== undefined && req.query.customerreference !== '') {
      postData.customerreference = req.query.customerreference;
    }

    // Call API
    axiosInstance.post(url, postData)
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
      'version': commons.getNodeVersion()
    })
    .then(response => {
      var localip = req.body.host;
      if (localip.toLowerCase() == 'localhost') localip = internalIp.v4.sync();
      if (localip === undefined) localip = "";  

      const qrCodeData = {
        'name': req.body.name,
        'server': req.body.server,
        'localip': localip,
        'localport': req.body.localport,
        'localprotocol': req.body.protocol,
        'baseurl': req.body.baseurl,
        'instancehash': response.data.instancehash,
        'apphash': response.data.apphash,
        'password': response.data.password,
        'customerhash': response.data.customerhash,
        'nodeversion': 2.0,
        'timestamp': Date.now()
      };
      const qrCodeString = JSON.stringify(qrCodeData);
      const qrCodeStringBuffer = Buffer.from(qrCodeString);
      const qrCodeStringBase64 = qrCodeStringBuffer.toString('base64');
      const link = response.data.appurl + '://add?data=' + qrCodeStringBase64;
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
    const safeName = path.basename(req.params.filename);
    const fileBase64 = fs.readFileSync(__dirname + '/resources/' + safeName, {encoding: 'base64'});
    res.json({ 'filedata': fileBase64 });
  });

}
