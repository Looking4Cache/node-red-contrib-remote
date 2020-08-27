module.exports = function(RED) {
  var child_process = require('child_process');

  function makeid(length) {
    var result           = '';
    var characters       = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for ( var i = 0; i < length; i++ ) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

  function RemoteAccessNode(config) {
    RED.nodes.createNode(this,config);

    // Retrieve the config node
    this.confignode = RED.nodes.getNode(config.confignode);
    if ( this.confignode ) {
      this.log("this.confignode.name: " + this.confignode.name);
      this.log("this.confignode.installhash: " + this.confignode.installhash);
    } else {
      this.log("this.confignode missing");
    }

    this.log("exec ssh");
    const sshprocess = child_process.spawn("ssh", ['-o StrictHostKeyChecking=no', '-R', '9999:localhost:1880', 'forward@88.198.112.131', '-N']);
    this.status({fill:"green",shape:"dot",text:"serving"});

    sshprocess.stdout.on('data', (data) => {
      console.log("ssh process stdout: " + data);
    });

    sshprocess.stderr.on('data', (data) => {
      console.error("ssh process stderr: " + data);
    });

    sshprocess.on('close', (code, signal) => {
      this.status({fill:"red",shape:"dot",text:"stopped"});
      this.log("ssh process stopped");
    });

    this.on('close', function() {
      this.status({fill:"red",shape:"dot",text:"stopping"});
      this.log("stopping ssh process");
      sshprocess.kill();
    });

    // node.log("this.credentials.installhash: " + this.credentials.installhash);
    // var installhash = this.credentials.installhash;
    // if ( installhash === undefined || installhash === '' ) {
    //  installhash = makeid(48)
    //  this.credentials.installhash = installhash
    //}
    //node.log("this.credentials.installhash: " + this.credentials.installhash);

    // this.status({fill:"green",shape:"dot",text:installhash});
  }

  RED.nodes.registerType("remote-access",RemoteAccessNode);

}
