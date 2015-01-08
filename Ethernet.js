const debug = require('debug')('connman-tests:ethernet');
const async = require('async');

var _connMan;
var _tech;
var _service;
var _available = false;

module.exports = Ethernet;

const ETHERNET_STATES = {
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
  _connMan = connMan;
}

Ethernet.prototype.init = function(callback) {
  _tech = _connMan.technologies.Wired;
  if(_tech === undefined) return callback(new Error("No ethernet available"));
  _tech.getServices(function(err, services) {
    //debug("wired getServices response: ",err/*,services*/);
    if(err) return callback(err);
    if(Object.keys(services).length === 0) return callback(new Error("No ethernet service available"));
    _available = true;
    //debug('found ethernet services: ' + Object.keys(services));
    async.eachSeries(Object.keys(services), function(serviceName,eachNext) {
      //debug('get ethernet service: ' + serviceName);
      _connMan.getService(serviceName, function(err, connection) {
        //debug('wired getConnection response: ',err/*,connection*/);
        _service = connection;
        _service.getProperties(function(err, props) {
          //debug('wired service \''+serviceName+'\' properties: ',err,props);
          //debug('wired service \''+serviceName+'\' state: ',props.State);
          debug('state: ',props.State);
          callback(err,props);
        });
        _service.on('PropertyChanged', function(name, value) {
          debug(name,'changed:',value);
        });
      });
    });
  });
}
Ethernet.prototype.getAvailable = function() {
  return _available;
}