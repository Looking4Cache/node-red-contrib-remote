const https = require('https');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

module.exports = {
  createAxiosInstance: function() {
    var filepath = path.join(__dirname, 'resources', 'ca.cer');
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false,
      ca: fs.readFileSync(filepath),
      checkServerIdentity: function(host, cert) {
        const pubkeyPinned = 'YHGEo54+LKxdpCuSAFt+Zwx/RVSHER96vM/Rh0/zcQ4=';
        const pubkeyServer = crypto.createHash('sha256').update(cert.pubkey).digest('base64');
        if (pubkeyPinned !== pubkeyServer) {
          return new Error('Certificate verification error');
        }
      }
    });
    return axios.create({
      httpsAgent: httpsAgent,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  },

  testUrlAvailable: async function(url) {
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false,
    });
    const axiosInstance = axios.create({ httpsAgent: httpsAgent, timeout: 2000 });
    try {
      let responseUi = await axiosInstance.get(url);
      if (responseUi.status >= 200 && responseUi.status <= 399) return true;
    } catch (err) {
    }
    return false;
  },

  getNodeVersion: function() {
    var filepath = path.join(__dirname, '..', 'package.json');
    var pjson = require(filepath);
    return pjson.version;
  },

  evaluateValue: function(RED, value, type, node, msg, tostring) {
    // Evaluates the value
    let evalValue = ''
    try {
      evalValue = RED.util.evaluateNodeProperty(value, type, node, msg);
      if (tostring) {
        if (evalValue == undefined) evalValue = '';
        evalValue = String(evalValue);
      }
    } catch (e) {
      node.error(`Error evaluating value: ${e}`)
    }
    return evalValue;
  },

  getNetworkErrorString: function(error) {
    // Trys to get a error message
    let errorString = `` + error;
    if ( error.response && error.response.data && error.response.data.message ) {
      errorString = `${error.response.data.message}`;
    }
    return errorString;
  },

  getNetworkErrorCustomString: function(error) {
    // Custom error messages for common errors
    let errorString = undefined;
    if ( error.code === 'ECONNABORTED' ) {
      errorString = `Error during https call. Please check Internet connection on your Node-RED server. Please check if a firewall blocks outgoing port 443.`;
    }
    if ( error.code === 'EAI_AGAIN' ) {
      errorString = `Error during DNS queries. Please check Internet connection on your Node-RED server. Please check if a firewall blocks your DNS queries.`;
    }
    return errorString;
  },

  reportError: function(error, node, caller) {
    if (error instanceof AggregateError) {
      error.errors.forEach(errorElem => {
        this.reportError(errorElem, node, caller);
      });
    } else {
      node.error(`${caller}: ${error.code}: ${(error.stack !== undefined) ? error.stack : error.message}`);
    }
  }

}
