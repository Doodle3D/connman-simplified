var util            = require("util");
var EventEmitter    = require("events").EventEmitter;
var debug           = require('debug')('connman-simplified:base');

module.exports = Base;

var _self;
var STATE_SHORTHANDS = {online: 'O', 
                        ready: 'R', 
                        association: 'a', 
                        configuration: 'c', 
                        disconnecting: 'd',
                        idle: ' ',
                        failure: 'x'};

function Base() {
  _self = this;
}

util.inherits(Base, EventEmitter);

Base.prototype.parseServices = function(raw) {
  var parsed = {};
  for (var key in raw) {
    var service = _self.parseService(raw[key]);
    //if(service.state === 'failure') continue;
    parsed[key] = service;
  }
  return parsed;
};

Base.prototype.parseProperties = function(rawProperties) {
  var properties = {};
  for (var propType in rawProperties) {
    properties[_self.lowerCaseFirstLetter(propType)] = rawProperties[propType];
  }
  return properties;
};

Base.prototype.parseService = function(rawService) {
  rawService = _self.parseProperties(rawService);
  var service = {};
  var include = ["state","strength","security","favorite","immutable","autoConnect"];
  for (var propType in rawService) {
    if(include.indexOf(propType) === -1) continue;
    service[propType] = rawService[propType];
  }
  service.ssid = rawService.name ? rawService.name : '*hidden*';
  service.ipaddress = (rawService.iPv4 && rawService.iPv4.address) ? rawService.iPv4.address : '';
  service.ipaddress = (rawService.iPv6 && rawService.iPv6.address) ? rawService.iPv6.address : '';
  return service;
};

Base.prototype.getServicesString = function(services) {
  var servicesString = "\n";
  for(var serviceName in services) {
    var service = services[serviceName];
    var serviceLine = service.favorite? '*' : ' ';
    serviceLine += service.autoconnect? 'A' : ' '; 
    serviceLine += STATE_SHORTHANDS[service.state];
    serviceLine += " '"+service.ssid+"'";
    serviceLine += " ["+service.security+"]\n";
    servicesString += serviceLine;
  }
  return servicesString;
};

Base.prototype.upperCaseFirstLetter = function(string) {
    return string.charAt(0).toUpperCase()+string.slice(1);
};
Base.prototype.lowerCaseFirstLetter = function(string) {
    return string.charAt(0).toLowerCase()+string.slice(1);
};