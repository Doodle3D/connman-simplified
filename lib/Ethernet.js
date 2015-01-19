var debug           = require('debug')('connman-simplified:ethernet');
var util            = require("util");
var Base            = require('./Base');

var _connman;
var _tech;
var _service;
var _techProperties = {}; // object containing all the wired tech properties
var _serviceProperties = {}; // object containing all the service properties (filtered by parseService)
var _services = [];
var _self;

module.exports = Ethernet;
module.exports.STATES = STATES;

var STATES = {
  IDLE: 'idle',
  FAILURE: 'failure',
  ASSOCIATION: 'association',
  CONFIGURATION: 'configuration',
  READY: 'ready',
  DISCONNECT: 'disconnect',
  ONLINE: 'online',
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

    getCurrentService(function(err,service, serviceProperties) {
      if(callback) callback(err,serviceProperties);
      setService(service,serviceProperties); 
    });
    _tech.getServices(function(err,services) {
      if(err) return;
      _services = _self.parseServices(services);
    });
  });
  // Monitor manager and technogy API
  _tech.on('PropertyChanged', onTechPropertyChanged);
  _connman.on('ServicesChanged',onServicesChanged);
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
  _tech.searchService({State:['ready','online']},function(err,service,properties) {
    if(err) callback(err); 
    else callback(err, service, _self.parseService(properties)); 
  });
}

function setService(service,properties) {
  var newServiceName = service? service.name : '';
  var currentServiceName = _service? _service.name : '';
  if(newServiceName == currentServiceName) return; 
  //debug('setService: ',newServiceName);
  
  if(_service) _service.removeAllListeners();
  _service = service;
  
  if(service) {
    _serviceProperties = properties;
    _service.on('PropertyChanged', onServicePropertyChanged);
  } else {
    for(var type in _serviceProperties) {
      _serviceProperties[type] = '';
    }
    _serviceProperties.state = 'idle';
  }
  for(var type in _serviceProperties) {
    _self.emit(type,_serviceProperties[type]);
  }
  _self.emit('serviceChanged',service,properties);
}

function onTechPropertyChanged(type, value) {
  type = _self.lowerCaseFirstLetter(type);
  if(_techProperties[type] == value) return;
  //debug("tech property changed: "+type+": ",value);
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
  //debug("service property changed: "+type+": ",value);
  _serviceProperties[type] = value; 
  _self.emit(type,value);
  if((type == 'IPv4' || type == 'IPv6') && value.Address) {
    _self.emit('ipaddress',value.Address);
  }
}

function onServicesChanged(changes,removed) {
  var numNew = 0;
  for(var key in changes) {
    if(Object.keys(changes[key]).length > 0) { // not empty
      numNew++;
    }
  }
  //debug("ServicesChanged: added: "+numNew+" removed: "+Object.keys(removed).length);
  // Future: emit per removed network a networkRemoved event
  // Future: emit per added network a networkAdded event
  
  _tech.getServices(function(err,services) {
    services = _self.parseServices(services);
    // ToDo: changed? 
    _services = services; 
    //debug("services: ",_self.getServicesString(services));
  });
  // update current service
  getCurrentService(function(err,service, serviceProperties) {
    setService(service,serviceProperties); 
  });
}