const https = require('https')
const axios = require('axios')
const fs = require('fs');
const crypto = require('crypto');

module.exports = {
  createAxiosInstance: function() {
    const httpsAgent = new https.Agent({
      ca: fs.readFileSync(__dirname + '/resources/ca.cer'),
      checkServerIdentity: function(host, cert) {
        const pubkeyPinned = 'YHGEo54+LKxdpCuSAFt+Zwx/RVSHER96vM/Rh0/zcQ4=';
        const pubkeyServer = crypto.createHash('sha256').update(cert.pubkey).digest('base64');
        if (pubkeyPinned !== pubkeyServer) {
          return new Error('Certificate verification error');
        }
      }
    });
    return axios.create({ httpsAgent: httpsAgent });
  }
}
