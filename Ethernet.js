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
  
  async.series([
    function(next) {
      if(_tech === undefined) {
        return next(new Error("No ethernet available"));
      }
      next();
    },
    function(next) {
      _tech.getServices(function(err, services) {
        if(err) return next(err); 
        if(Object.keys(services).length === 0) return next(new Error("No ethernet service available"));
        _available = true;
        //debug('found ethernet services: ' + Object.keys(services));
        async.eachSeries(Object.keys(services), function(serviceName,eachNext) {
          //debug('get ethernet service: ' + serviceName);
          _connMan.getService(serviceName, function(err, service) {
            if(err) return next(err); 
            //debug('wired getConnection response: ',err/*,connection*/);
            _service = service;
            _service.getProperties(function(err, props) {
              if(err) return next(err); 
              //debug('wired service \''+serviceName+'\' properties: ',err,props);
              //debug('wired service \''+serviceName+'\' state: ',props.State);
              debug('State: ',props.State);
              next(err,props);
            });
            _service.on('PropertyChanged', function(name, value) {
              debug(name,'changed:',value);
            });
          });
        });
      })
    }
  ],function(err) {
    if(callback) callback(err); 
  });
}
Ethernet.prototype.getAvailable = function() {
  return _available;
}