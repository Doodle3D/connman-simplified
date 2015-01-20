var debug           = require('debug')('connman-simplified:wifi');
var async           = require('async');
var fs              = require('fs');
var util            = require("util");
var Base            = require('./Base');
var ms              = require('ms');
var configFiles     = require('./ConfigFiles.js');

var _timeoutWiFiEnable = 3000;
var _scanRetryTimeout = 1000; //5000;
var _numScanRetries = 5; //3;
var _getServiceRetryTimeout = _scanRetryTimeout;
var _numGetServiceRetries = _numScanRetries;
var _connman;
var _tech;
var _service; // service we are connected to
var _agent;
var _networks = []; // current wifi services info (filtered by parseServices)
var _networksCache = []; // cache of networks, use while tethering
var _techProperties = {}; // object containing all the wifi tech properties
var _serviceProperties = {}; // object containing all the service properties (filtered by parseService)
var _self;

/** https://kernel.googlesource.com/pub/scm/network/connman/connman/+/1.14/doc/service-api.txt
 *  string State [readonly]
 *     The service state information.
 *     Valid states are "idle", "failure", "association", "configuration", "ready", "disconnect" and "online".
 */
var STATES = {
  IDLE: 'idle',
  FAILURE: 'failure',
  ASSOCIATION: 'association',
  CONFIGURATION: 'configuration',
  READY: 'ready',
  DISCONNECT: 'disconnect',
  ONLINE: 'online',
};

module.exports = WiFi;
module.exports.STATES = STATES;

function WiFi(connman) {
  Base.call(this);
  _self = this;
  _connman = connman;
}

util.inherits(WiFi, Base);

WiFi.prototype.init = function(callback) {
  debug("init: ");
  _self = this;
  // Retrieve WiFi technology
  // https://kernel.googlesource.com/pub/scm/network/connman/connman/+/1.14/doc/technology-api.txt
  _tech = _connman.technologies.WiFi;
  if(_tech === undefined) {
    if(callback) callback(new Error("No WiFi hardware available"));
    return;
  }
  _self.getProperties(function(err, properties) {
    if(err) {
      if(callback) callback(err); 
      return;
    }
    _techProperties = properties;
    if(properties.powered) { // already powered? 
      if(callback) callback(null,properties);
      return;
    }
    _self.enable(function(err) {
      if(callback) callback(err,properties);
    });
  });
  // Monitor manager and technogy API
  _connman.on('ServicesChanged',onServicesChanged);
  _tech.on('PropertyChanged',onTechPropertyChanged);
  
  // Get current services (networks) 
  _tech.getServices(function(err,services) {
    //debug("_connman.getServices respone: ",arguments);
    if(err) return debug("[Warning] Coulnd't get current services: ",err);
    setNetworks(_self.parseServices(services));
  });
  // Monitor current service (network) 
  getCurrentService(function(err,service,serviceProperties) {
    if(err) return;
    setService(service,serviceProperties);
  });
};
WiFi.prototype.enable = function(callback) {
  // Note: Hostmodule tries this 3 times?
  _self.setProperty('Powered', true, function(err) {
    //debug("WiFi setProperty 'Powered' true response: ",err);
    // delay, probably because of: https://01.org/jira/browse/CM-644
    setTimeout(callback, _timeoutWiFiEnable, err);
  });
};
WiFi.prototype.disable = function(callback) {
  _self.setProperty('Powered', false, callback);
};
WiFi.prototype.setProperty = function(type, value, callback) {
  _tech.setProperty(_self.upperCaseFirstLetter(type), value, function(err) {
    if(callback) callback(err);
  });
};
WiFi.prototype.getProperty = function(type, callback) {
  _self.getProperties(function(err, properties) {
    if(err) return callback(err);
    return callback(null,properties[type]);
  });
};
WiFi.prototype.getProperties = function(callback) {
  _tech.getProperties(function(err,properties) {
    var filtered = {};
    for(var key in properties) {
      filtered[_self.lowerCaseFirstLetter(key)] = properties[key];
    }
    callback(err,filtered);
  });
};
WiFi.prototype.getConnectionProperties = function(callback) {
  callback(null,_serviceProperties);
};
WiFi.prototype.getNetworks = function(callback) {
  debug("getNetworks");
  async.retry(_numScanRetries, function(nextRetry) {
    _self.scan(function(err) {
      if(err) return setTimeout(nextRetry, _scanRetryTimeout, err);
      _tech.getServices(function(err,services) {
        //debug("listAccessPoints response: ",err,services);
        if(Object.keys(services).length === 0) {
          return setTimeout(nextRetry, _scanRetryTimeout, new Error('No WiFi networks found'));
        }
        setNetworks(_self.parseServices(services));
        callback(null, _networks);
      });
    });
  },callback);
};
WiFi.prototype.getNetworksCache = function(callback) {
  debug("getNetworksCache");
  callback(null, _networksCache);
};
WiFi.prototype.scan = function(switchTethering,callback) {
  if(typeof switchTethering == 'function') {
    callback = switchTethering;
    switchTethering = false;
  }
  debug("scan "+(switchTethering? '& switchTethering' : ''));
  
  if(_techProperties.tethering && !switchTethering) {
    debug("[Warning] Scanning while in tethering mode is usually not supported");
  }
  
  // Because our hardware can't scan and tether at the same time we 
  // might need to switch off tethering, scan and start tethering again
  // ToDo: research wheter it's possible to keep the hotspot clients connected
  if(_techProperties.tethering && switchTethering) {
    var startTime = Date.now();
    _self.closeHotspot(function(err) {
      _self.scan(function() { // ToDo: add retries?
        logNetworks();
        _self.openHotspot(null,null,function(err) {
          debug('switchTethering time: ',ms(Date.now()-startTime));
          if(callback) callback(err);
        });
      });
    });
  } else {
    _tech.scan(function(err) {
      if(err) {
        debug("[Error] scanning: ",err);
        if(err.message == 'org.freedesktop.DBus.Error.NoReply') {
          debug("[Error] Scan failed, probably because I'm a hotspot / tethering");
        }
      }
      if(callback) callback(err);
    });
  }
};
WiFi.prototype.join = function(ssid,passphrase,callback) {
  debug("join: ",ssid);
  if(ssid === undefined) {
    if(callback) callback(new Error("ssid is required"));
    return;
  }
  if(typeof passphrase == 'function') {
    callback = passphrase;
    passphrase = '';
  }
  var targetService; 
  var targetServiceProperties; 
  async.series([
    _self.closeHotspot,
    function doGetService(next) { 
      //debug("doGetService: ",ssid);
      async.retry(_numGetServiceRetries, function(nextRetry) {
        //debug("(re)attempt scan & getService");
        _self.scan(); // start scan, but don't wait for it
        getServiceBySSID(ssid,function(err,service,properties) {
          //debug("getService response: ",err,service);
          if(err) return setTimeout(nextRetry, _getServiceRetryTimeout, err);
          targetService = service;
          targetServiceProperties = properties;
          next();
        });
      },next);
    },
    function doHandleSecurity(next) {
      if (targetServiceProperties.security.indexOf('none') > -1) {
        debug('[NOTE] this is an open network');
        return next();
      }
      debug('[NOTE] this network is protected with: ' + targetServiceProperties.security);
      if(!passphrase || passphrase == '') {
        if(targetServiceProperties.favorite) next();
        else next(new Error("No passphrase supplied for secured network"));
      } else {
        configFiles.create(ssid,passphrase,next);
      }
    },
    // Hostmodule has a disconnect here, not sure why...
    function switchService(next) {
      setService(targetService,targetServiceProperties);
      next();
    },
    function doConnect(next) {
      _service.connect(function(err, newAgent) {
        debug("connect response: ",err || ''/*,newAgent*/);
        if (err) return next(err);
        _agent = newAgent;
        next();
      });
    },
    function doListen(next) {
      function onChange(type, value) {
        if(type !== 'State') return;
        //debug("service State: ",value);
        switch(value) {
          // when wifi ready and online
          case STATES.READY:
          case STATES.ONLINE:
  //          self.connman.getOnlineService(function(err, _service) {
  //            if (_service.Type === 'ethernet' && _service.State === 'online') {
  //              if (self.wifiState !== STATES.ONLINE) {
  //                debug('[NOTE] online through ethernet');
  //                self._updateEthernetState(ETHERNET_STATES.ONLINE);
  //              }
  //            }
  //          });
            _service.removeListener('PropertyChanged',onChange);
            next();
            break; 
          case STATES.FAILURE:
            var err = new Error("Joining network failed (wrong password?)");
            _service.removeListener('PropertyChanged',onChange);
            next(err);
            // ToDo include error... (sometimes there is a Error property change, with a value like 'invalid-key')
            break;
        }
      }
      _service.on('PropertyChanged',onChange);  
      _agent.on('Release', function() {
        debug("agent: Release: ",arguments);
      });
      _agent.on('ReportError', function(service, error) {
        debug("agent: ReportError: ",arguments);
      });
      _agent.on('RequestBrowser', function(service, url) {
        debug("agent: RequestBrowser: ",arguments);
      });
      _agent.on('RequestInput', function(service, url, callback) {
        debug("agent: RequestInput: ",arguments);
      });
      _agent.on('Cancel', function() {
        debug("agent: Cancel: ",arguments);
      });
    }
  ],function(err,results) {
    debug('join finished: ',err || '');
    if(callback) callback(err);
  });
};
WiFi.prototype.joinFavorite = function(callback) {
  debug("joinFavorite");
  var favoriteAP;
  async.series([
    _self.closeHotspot,
    function doFindFavoriteNetwork(next) {
      _self.getNetworks(function(err,list) {
        if(err) return next(err);
        for (var index in list) {
          var ap = list[index];
          if(ap.favorite) {
            favoriteAP = ap;
            return next();
          }
        } 
        var err = new Error("No favorite network found");
        next(err);
      });
    },
    function doConnect(next) {
      //--join favorite, passphrase: '' because a) open network, b) known /var/lib/connman/network- file
      _self.join(favoriteAP.ssid,function(err) {
        //debug('join response: ',err || '');
        next(err);
      });
    }
  ], function(err) {
    debug('joinFavorite series finished: ',err || '');
    if(callback) callback(err); 
  });
};
WiFi.prototype.disconnect = function(callback) {
  debug("disconnect");
  getCurrentService(function(err,service) {
    if(err) {
      if(callback) callback(err);
      return;
    }
    service.disconnect(function(err) {
      //debug("disconnect response: ",err);
      if (err) {
        if (callback) callback(err);
        return;
      }
      //debug('disconnected from ' + serviceName + '...');
      if(_agent) _agent.removeAllListeners();
      if(callback) callback();
    });
  });
};
WiFi.prototype.forgetNetwork = function(ssid,callback) {
  debug('forgetNetwork: ',ssid);
  
  getServiceBySSID(ssid,function(err,service) {
    if(err) {
      if(callback) callback(err); 
      return;
    }
    if (service) service.remove();
  });
  configFiles.remove(ssid,callback);
};
WiFi.prototype.closeHotspot = function(callback) {
  debug("closeHotspot");
  // Having changing the Tethering property doesn't mean the hotspot is closed. 
  // A better indicator is listening to Tethering and Powered property changes
  // The Tethering changes to false, Powered is set to true (maybe the device restarts?)
  // But the best indicator seems to wait for the available services to change.
  function onChange(changes,removed) {
    if(callback) callback();
    _connman.removeListener('ServicesChanged',onChange);
  }
  _connman.on('ServicesChanged',onChange);
  
  _tech.disableTethering(function(err, res) {
    //debug("disableTethering response: ",err,res);
    if (err) {
      // not reporting already disabled as error
      if (err.message === 'net.connman.Error.AlreadyDisabled') {
        debug('[NOTE] Hotspot already closed');
        err = null;
      } 
      _connman.removeListener('ServicesChanged',onChange);
      if (callback) callback(err);
      return;
    }
  });
};
WiFi.prototype.openHotspot = function(ssid,passphrase,callback) {
  debug("openHotspot");  
  // changing ssid or passphrase works while already hotspot requires disable first
  // see: https://01.org/jira/browse/CM-668
  var args = arguments;
  if(_techProperties.tethering) {
    _self.closeHotspot(function() {
      _tech.enableTethering.apply(_tech,args);
    });
  } else {
    _tech.enableTethering.apply(_tech,args);
  }
};

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
    setNetworks(_self.parseServices(services),false);
  });
  // update current service
  getCurrentService(function(err,service, serviceProperties) {
    setService(service,serviceProperties); 
  });
}
function onTechPropertyChanged(type, value) {
  type = _self.lowerCaseFirstLetter(type);
  if(_techProperties[type] == value) return;
  //debug("tech property changed: "+type+": ",value);
  _techProperties[type] = value;
  _self.emit(type,value);
  _self.emit('propertyChanged',type,value);
  logStatus();
}
function onServicePropertyChanged(type, value) {
  type = _self.lowerCaseFirstLetter(type);
  if(type == "error") {
    debug("[ERROR] service error: ",value);
    return;
  }
  if(_serviceProperties[type] == value) return;
  //debug("service property changed: "+type+": ",value);
  _serviceProperties[type] = value; 
  _self.emit(type,value);
  _self.emit('connectionPropertyChanged',type,value);
  // ToDo: if value is Object, lowercase all properties
  if((type == 'IPv4' || type == 'IPv6') && value.Address) {
    type = 'ipaddress';
    value = value.Address;
    _self.emit(type,value);
    _self.emit('connectionPropertyChanged',type,value);
  }
  if(type == 'name') {
    _self.emit('ssid',value);
    _self.emit('connectionPropertyChanged','ssid',value);
  }
  switch(type) {
    case 'state':
    case 'name':
    case 'security':
    case 'ipaddress':
      logStatus();
      break;
  }
}

function setService(service,properties) {
  var newServiceName = service? service.name : '';
  var currentServiceName = _service? _service.name : '';
  if(newServiceName == currentServiceName) return; 
  debug('setService: ',newServiceName);
  //debug('  old: ',currentServiceName);
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
  logStatus();
}

function setNetworks(networks,log) {
  _networks = networks;
  if(log === undefined) log = true;
  if(log) logNetworks();
  if(!_techProperties.tethering) {
    _networksCache = _networks;
    //debug("networksCache: ",_networksCache);
  }  
  // emit networks list as array
  var networksArr = [];
  for (var key in _networks) {
      networksArr.push(_networks[key]);
  }
  _self.emit('networks',networksArr);
}
function getCurrentService(callback) {
  _tech.searchService({State:[  STATES.ASSOCIATION,
                                STATES.CONFIGURATION,
                                STATES.DISCONNECT,
                                STATES.FAILURE,
                                STATES.ONLINE,
                                STATES.READY]},
                      function(err,service,properties) {
    if(err) callback(err); 
    else callback(err, service, _self.parseService(properties)); 
  });
}
function getServiceBySSID(ssid,callback) {
  _tech.searchService({Name:ssid},function(err,service,properties) {
    if(err) callback(err); 
    else callback(null, service, _self.parseService(properties)); 
  });
}

function logStatus() {
//  var techProps = _techProperties;
//  var serviceProps = _serviceProperties;
//  if(serviceProps && serviceProps.state){
//    var connectionStatus = 'connection status: ';
//    connectionStatus += (techProps.connected)? "Connected" : "Disconnected"; 
//    connectionStatus += " "+serviceProps.state;
//    connectionStatus += " '"+serviceProps.ssid+"'";
//    connectionStatus += " "+serviceProps.security;
//    connectionStatus += " "+serviceProps.ipaddress;
//    debug(connectionStatus);
//  }
//  if(techProps && techProps.tethering) {
//    debug('tethering: ',techProps.tetheringIdentifier,techProps.tetheringPassphrase);
//  }
}
function logNetworks() {
  debug('Networks: '+_self.getServicesString(_networks));
}