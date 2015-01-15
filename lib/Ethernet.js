var debug           = require('debug')('connman-simplified:ethernet');
var util            = require("util");
var Base            = require('./Base');

var _connman;
var _tech;
var _service;
var _techProperties = {}; // object containing all the wired tech properties
var _serviceProperties = {}; // object containing all the service properties (filtered by parseService)
var _self;

module.exports = Ethernet;

var ETHERNET_STATES = {
  IDLE: 'idle',
  FAILURE: 'failure',
  ASSOCIATION: 'association',
  CONFIGURATION: 'configuration',
  READY: 'ready',
  DISCONNECT: 'disconnect',
  ONLINE: 'online',
  CONNECTING: 'connecting', //--extra
  UNKNOWN: 'unkown', //--extra
  DISABLED: 'disabled'
};

function Ethernet(connMan) {
  Base.call(this);
  _connman = connMan;
  _self = this;
}

util.inherits(Ethernet, Base);

Ethernet.prototype.init = function(callback) {
  _tech = _connman.technologies.Wired;
  if(_tech === undefined) {
    if(callback) callback(new Error("No Ethernet available"));
    return;
  }
  // get current tech properties
  _self.getProperties(function(err, properties) {
    if(err) {
      if(callback) callback(err); 
      return;
    }
    _techProperties = properties;
    getCurrentService(function(err,service) {
      if(callback) callback(err,properties);
      if(service) setService(service); 
    });
  });
  _tech.on('PropertyChanged', onTechPropertyChanged);
};

Ethernet.prototype.getProperties = function(callback) {
  _tech.getProperties(function(err,properties) {
    var filtered = {};
    for(var key in properties) {
      filtered[_self.lowerCaseFirstLetter(key)] = properties[key];
    }
    callback(err,filtered);
  });
};

function getCurrentService(callback) {
  _tech.getServices(function(err, services) {
    if(err) {
      if(callback) callback(err);
      return;
    }
    if(Object.keys(services).length === 0) {
      if(callback) callback(new Error("No ethernet service available"));
      return;
    }
    // currently assuming one service for ethernet
    var serviceName = Object.keys(services)[0];
    _connman.getService(serviceName, function(err, service) {
      if(err) {
        if(callback) callback(err);
        return; 
      }
      callback(null,service);
    });
  });
}

function setService(service) {
  if(_service) _service.removeAllListeners();
  _service = service;
  // get properties (logStatus)
  _service.getProperties(function(err, props) {
    //debug("new service properties: ",props);
    _serviceProperties = _self.parseService(props);
    for(var type in _serviceProperties) {
      _self.emit(type,_serviceProperties[type]);
    }
  });
  // listen for property changes
  _service.on('PropertyChanged', onServicePropertyChanged);
}

function onTechPropertyChanged(type, value) {
  type = _self.lowerCaseFirstLetter(type);
  if(_techProperties[type] == value) return;
  debug("tech property changed: "+type+": ",value);
  _techProperties[type] = value;
  _self.emit(type,value);
}

function onServicePropertyChanged(type,value) {
  type = _self.lowerCaseFirstLetter(type);
    if(type == "error") {
    debug("[ERROR] service error: ",value);
    return;
  }
  if(_serviceProperties[type] == value) return;
  debug("service property changed: "+type+": ",value);
  _serviceProperties[type] = value; 
  _self.emit(type,value);
  if((type == 'IPv4' || type == 'IPv6') && value.Address) {
    _self.emit('ipaddress',value.Address);
  }
}