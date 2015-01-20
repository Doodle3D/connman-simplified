var debug           = require('debug')('connman-simplified');
var util            = require("util");
var Connman         = require("connman-api");
var Base            = require('./Base');
var WiFi            = require('./WiFi');
var Ethernet        = require('./Ethernet');

var _self;
var _connman;
var _wifi;
var _ethernet;
var _properties = {}; // Connman manager properties
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
  
  _self = this;
}
util.inherits(ConnmanSimplified, Base);

ConnmanSimplified.prototype.init = function(callback) {
  _connman = new Connman();
  _connman.init(function(err) {
    if(err) {
      if(callback) callback(err); 
      return;
    }
    _connman.getProperties(function(err, properties) {
      if(err) {
        if(callback) callback(err); 
        return;
      }
      _properties = _self.parseProperties(properties);
      callback(null,_properties);
    });
  });
  
  // Monitor manager and technogy API
  _connman.on('PropertyChanged',onPropertyChanged);
  _connman.on('ServicesChanged',onServicesChanged);
};
ConnmanSimplified.prototype.initWiFi = function(callback) {
  _wifi = new WiFi(_connman);
  _wifi.init(function(err,properties) {
    callback(err,_wifi,properties);
  });
};
ConnmanSimplified.prototype.initEthernet = function(callback) {
  _ethernet = new Ethernet(_connman);
  _ethernet.init(function(err,properties) {
    callback(err,_ethernet,properties);
  });
};

function onPropertyChanged(type, value) {
  type = _self.lowerCaseFirstLetter(type);
  if(_properties[type] == value) return;
  //debug("property changed: "+type+": ",value);
  _properties[type] = value;
  _self.emit(type,value);
}
function onServicesChanged(changes,removed) {
  var numNew = 0;
  for(var key in changes) {
    if(Object.keys(changes[key]).length > 0) { // not empty
      numNew++;
    }
  }
  debug("ServicesChanged: added: "+numNew+" removed: "+Object.keys(removed).length);
  _connman.getServices(function(err,services) {
    services = _self.parseServices(services);
    //debug('Networks: '+_self.getServicesString(_networks));
    // emit networks list as array
    var arr = [];
    for (var key in services) {
        arr.push(services[key]);
    }
    _self.emit('services',arr);
    _self.emit('networks',arr);
  });
  // Future: emit per removed network a networkRemoved event
}
  