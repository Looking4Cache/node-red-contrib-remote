module.exports = function(RED) {
  const commons = require('./remote-commons');
  const internalIp = require('internal-ip');
  const ping = require('ping');
  const dns = require('dns'); 
  const dnsPromises = dns.promises;
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

  function getErrorMessage(error) {
    let errorMessage = error.message;
    if ( error.response && error.response.data && error.response.data.message ) {
      errorMessage = errorMessage + " / " + error.response.data.message;
    }
    if ( commons.getNetworkErrorCustomString(error) !== undefined) {
      errorMessage = commons.getNetworkErrorCustomString(error);
    }
    return errorMessage;
  }

  RED.httpAdmin.get("/contrib-remote/testNetwork", RED.auth.needsPermission('remote-config.read'), async function(req,res) {
    // Test the network conditions

    const testResults = [];

    const axiosInstance = commons.createAxiosInstance();

    // All servers to check
    const serversToCheck = ['contact-dev.remote-red.comx', 'contact-de.remote-red.com'];

    // DNS probe
    const promisesDns = serversToCheck.map(host => {
      return dnsPromises.lookup(host, {all: true})
            .then(res => {
              const v4 = res.some(e => e.family === 4);
              const v6 = res.some(e => e.family === 6);
              testResults.push({type: 'DNS', test: `DNS lookup ${host}`, result: getErrorMessage(error)});
              console.log(res);
              // testResults.push({test: `DNS lookup ${host}`, result: res.alive ? `${res.time}ms` : 'Error'});
            })
            .catch(error => {
              console.log(error);
              console.log(`dns resolve ${host}: ${getErrorMessage(error)}`);
              // console.log(error);
              testResults.push({type: 'DNS', test: `DNS lookup ${host}`, result: getErrorMessage(error)});
            });
    });
    await Promise.all(promisesDns);

    // Ping hosts
    const additionalPingHosts = ['google.com', '173.212.245.41', '2a02:c207:3006:3079::1'];
    const promisesPings = [...serversToCheck, ...additionalPingHosts].map(host => {
      return ping.promise.probe(host)
            .then(res => {
              testResults.push({type: 'PING', test: `ping ${host}`, result: res.alive ? `${res.time}ms` : 'Error'});
            });
    });
    await Promise.all(promisesPings);

    // Make https test call
    const promisesHttpsCalls = serversToCheck.map(url => {
      return axiosInstance.get(`https://${url}/testNetwork`)
      .then(response => {
        testResults.push({test: `https call to ${url}`, result: 'OK'});
      })
      .catch(error => {
        console.log(`https call to ${url}: ${getErrorMessage(error)}`);
        // console.log(error);
        testResults.push({type: 'HTTPS', test: `https call to ${url}`, result: getErrorMessage(error)});
      });
    });
    await Promise.all(promisesHttpsCalls);
    
    console.log(testResults);
    res.json(testResults);
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

    // Call API
    axiosInstance.post(url, {
      'customerhash': req.params.customerhash,
      'customerkey': req.params.customerkey,
      'version': commons.getNodeVersion()
    })
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
        'baseurl': req.body.baseurl,
        'instancehash': response.data.instancehash,
        'apphash': response.data.apphash,
        'password': response.data.password,
        'customerhash': response.data.customerhash,
        'nodeversion': 1.1
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
    const fileBase64 = fs.readFileSync(__dirname + '/resources/' + req.params.filename, {encoding: 'base64'});
    res.json({ 'filedata': fileBase64 });
  });

}
