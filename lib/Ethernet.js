var debug           = require('debug')('connman-simplified:ethernet');
var util            = require("util");
var Base            = require('./Base');

var _super = Base.prototype;
var STATES = {
  IDLE: 'idle',
  FAILURE: 'failure',
  ASSOCIATION: 'association',
  CONFIGURATION: 'configuration',
  READY: 'ready',
  DISCONNECT: 'disconnect',
  ONLINE: 'online',
};

module.exports = Ethernet;
module.exports.STATES = STATES;

function Ethernet(connman) {
  Base.call(this);
  this.connman = connman;
}

util.inherits(Ethernet, Base);

Ethernet.prototype.init = function(callback) {
  //debug("init");
  var self = this;
  // Retrieve WiFi technology
  // https://kernel.googlesource.com/pub/scm/network/connman/connman/+/1.14/doc/technology-api.txt
  var tech = self.connman.technologies.Wired;
  if(tech === undefined) {
    if(callback) callback(new Error("No Ethernet hardware available"));
    return;
  }
  _super.init.call(self,tech,function(err,properties) {
    if(callback) callback(err,properties);
  });
};