module.exports = function(RED) {
  function RemoteConfigNode(n) {
    RED.nodes.createNode(this,n);
    this.name = n.name;
    this.instancehash = n.instancehash;
    this.authentication = n.authentication;

    this.log("bin da");
  }
  RED.nodes.registerType("remote-config",RemoteConfigNode);
}
