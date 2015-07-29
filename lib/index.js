var debug           = require('debug')('connman-simplified');
var util            = require("util");
var Connman         = require("connman-api");
var Base            = require('./Base');
var WiFi            = require('./WiFi');
var Ethernet        = require('./Ethernet');

var _wifi;
var _ethernet;

var _super = Base.prototype;

module.exports = ConnmanSimplified;
module.exports.WiFi = WiFi;
module.exports.Ethernet = Ethernet;

function ConnmanSimplified() {
	if (!(this instanceof ConnmanSimplified)) return new ConnmanSimplified();
  
  Base.call(this);
  
  //NOTE: Network.js DBUS needs environment vars below
  //from: http://stackoverflow.com/questions/8556777/dbus-php-unable-to-launch-dbus-daemon-without-display-for-x11  
  if(!process.env.DBUS_SESSION_BUS_ADDRESS) {
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/dbus/system_bus_socket';
  }
  if(!process.env.DISPLAY) {
    process.env.DISPLAY = ':0';
  }
}
util.inherits(ConnmanSimplified, Base);

ConnmanSimplified.prototype.init = function(callback) {
  //debug("init");
  var self = this;
  self.connman = new Connman(true); // enableAgent
  self.connman.init(function(err) {
    if(err) {
      if(callback) callback(err); 
      return;
    }
    _super.init.call(self,self.connman,function(err,properties) {
      if(callback) callback(err,properties);
    });
  });
};
ConnmanSimplified.prototype.initWiFi = function(callback) {
  _wifi = new WiFi(this.connman);
  _wifi.init(function(err,properties) {
    callback(err,_wifi,properties);
  });
};
ConnmanSimplified.prototype.initEthernet = function(callback) {
  _ethernet = new Ethernet(this.connman);
  _ethernet.init(function(err,properties) {
    callback(err,_ethernet,properties);
  });
};