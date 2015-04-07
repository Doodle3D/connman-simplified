var util            = require("util");
var EventEmitter    = require("events").EventEmitter;
var debug           = require('debug')('connman-simplified:base');
var Parser          = require('./Parser');

module.exports = Base;
function Base() {
  this.connman = null;
  this.iface = null; // interface to the Technology API or Manager API
  this.service = null; // current service
  this.services = []; // current (wifi, wired) services info (filtered by parseServices)
  this.properties = {}; // object containing all the interface's properties
  this.serviceProperties = {}; // object containing all the current service's properties (filtered by parseService)
  EventEmitter.call(this);
}

util.inherits(Base, EventEmitter);

Base.prototype.init = function(iface,callback) {
  //debug("init");
  
  var self = this;
  self.iface = iface;
  iface.getProperties(function(err,rawProperties) {
    if(err) {
      if(callback) callback(err);
      return;
    }
    // ToDo use a general parser method
    for(var key in rawProperties) {
      self.properties[Parser.lowerCaseFirstLetter(key)] = rawProperties[key];
    }

    if(callback) callback(err,self.properties);
    
    // emit current properties after init callback, 
    // so added listeners can pick it up
    for(var type in self.properties) {
      self.emit(type,self.properties[type]);
    }
  });
  // Monitor manager and technogy API
  self.connman.on('ServicesChanged',onServicesChanged.bind(self));
  self.iface.on('PropertyChanged',onPropertyChanged.bind(self));
  
  // Get current services (networks) 
  self.iface.getServices(function(err,services) {
    //debug("_connman.getServices respone: ",arguments);
    if(err) return debug("[Warning] Coulnd't get current services: ",err);
    
    self._setServices.call(self,Parser.parseServices(services));
    updateCurrentService.call(self); 
  });
};

/********************
 * Public functions
 ********************/
Base.prototype.setProperty = function(type, value, callback) {
  this.iface.setProperty(Parser.upperCaseFirstLetter(type), value, function(err) {
    if(callback) callback(err);
  });
};
Base.prototype.getProperty = function(type) {
  return this.properties[type];
};
Base.prototype.getProperties = function() {
  return this.properties;
};
Base.prototype.getConnectionProperties = function() {
  return this.serviceProperties;
};
Base.prototype.getServicesString = function(services) {
  return Parser.getServicesString(services);
};
Base.prototype.getCurrentServices = function() {
  return this._obj2Arr(this.services);
};

/********************
 * Event handlers
 ********************/
function onServicesChanged(changes,removed) {
  var self = this;
  
  self.emit('servicesChanged',changes,removed);
  var numNew = 0;
  for(var key in changes) {
    if(Object.keys(changes[key]).length > 0) { // not empty
      numNew++;
    }
  }
  //debug("ServicesChanged: added: "+numNew+" removed: "+Object.keys(removed).length);
  // Future: emit per removed network a networkRemoved event
  // Future: emit per added network a networkAdded event
  this.iface.getServices(function(err,services) {
    self._setServices.call(self,Parser.parseServices(services),false);
    updateCurrentService.call(self); 
  });
}
function onPropertyChanged(type, value) {
  type = Parser.lowerCaseFirstLetter(type);
  if(this.properties[type] == value) return;
  // debug("tech property changed: "+type+": ",value);
  this.properties[type] = value;
  this.emit(type,value);
  this.emit('propertyChanged',type,value);
}
function onServicePropertyChanged(type, value) {
  type = Parser.lowerCaseFirstLetter(type);
  if(type == "error") {
    debug("[ERROR] service error: ",value);
    return;
  }
  if(this.serviceProperties[type] == value) return;
  // debug("service property changed: "+type+": ",value);
  this.serviceProperties[type] = value; 
  this.emit(type,value);
  this.emit('connectionPropertyChanged',type,value);
  // ToDo: if value is Object, lowercase all properties
  if((type === 'iPv4' || type === 'iPv6') && value.Address !== undefined) {
    var newType = (type == 'iPv4')? 'ip4Address' : 'ip6Address';
    var newValue = value.Address;
    this.emit(newType, value.Address);
    this.emit('connectionPropertyChanged', newType, newValue);
    this.serviceProperties[newType] = newValue; 
  }
  if(type == 'name') {
    var newType = 'ssid';
    this.emit(newType,value);
    this.emit('connectionPropertyChanged', newType, value);
    this.serviceProperties[newType] = value; 
  }
}

/********************
 * Protected functions
 ********************/
Base.prototype._setService = function(serviceName,callback) {
  var self = this;
  var currentServiceName = self.service? self.service.name : '';
  if(serviceName == currentServiceName) return; 
  //debug('setService: ',serviceName);
  //debug('  old: ',currentServiceName);
  if(self.service) self.service.removeAllListeners();
  
  self.connman.getService(serviceName,function(err,service,serviceProperties) {
    if(err) {
      if(callback) callback(err); 
      return;
    }
    self.service = service;
    self.serviceProperties = Parser.parseService(serviceProperties);
    for(var type in self.serviceProperties) {
      self.emit(type,self.serviceProperties[type]);
    }
    self.service.on('PropertyChanged', onServicePropertyChanged.bind(self));
    self.emit('serviceChanged',self.service,self.serviceProperties);
  });
};
Base.prototype._clearService = function() {
  //debug('clearService');
  if(this.service) { // was there a service? 
    this.service.removeAllListeners();
    this.service = null;
  }
  var type;
  // reset properties
  for(type in this.serviceProperties) {
    this.serviceProperties[type] = '';
  }
  // set connection state to idle
  this.serviceProperties.state = 'idle';
  this.serviceProperties.strength = 0;
  this.serviceProperties.ssid = '';
  // emit all properties
  for(type in this.serviceProperties) {
    this.emit(type,this.serviceProperties[type]);
  }
  this.emit('serviceChanged',this.service,this.serviceProperties);
};
Base.prototype._setServices = function(services,log) {
  this.services = services;
  //if(log === undefined) log = true;
  //if(log) logNetworks();
  // emit services/networks list as array
  var servicesArr = this._obj2Arr(services);
  this.emit('services',servicesArr);
  this.emit('networks',servicesArr);
};
Base.prototype._obj2Arr = function(obj) {
  var arr = [];
  for (var key in obj) {
      arr.push(obj[key]);
  }
  return arr;
};

/********************
 * Private functions
 ********************/
function updateCurrentService() {
  for(var serviceName in this.services) {
    // find first not idle service
    var serviceProperties = this.services[serviceName];
    if(serviceProperties.state != 'idle') {
      this._setService(serviceName);
      return;
    }
  }
  this._clearService(); // no active network found, clear current service
}