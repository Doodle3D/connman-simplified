const debug         = require('debug')('connman-tests:wifi');
const verbose       = require('debug')('connman-tests:wifi:verbose');
const async         = require('async');
const fs            = require('fs');
var util            = require("util");
var EventEmitter    = require("events").EventEmitter;

var _timeoutWiFiEnable = 3000;
var _scanRetryTimeout = 5000;
var _numScanRetries = 3;
var _getServiceRetryTimeout = _scanRetryTimeout;
var _numGetServiceRetries = _numScanRetries;
var _connman;
var _tech;
var _service; // service we are connected to
var _agent;
var _available = false;
var _networks = [];
var _techProperties = {}; // object containing all the wifi tech properties
var _serviceProperties = {}; // object containing all the service properties
var _hotspotSSID;
var _hotspotPassphrase;
var _self;

/** https://kernel.googlesource.com/pub/scm/network/connman/connman/+/1.14/doc/service-api.txt
 *  string State [readonly]
 *     The service state information.
 *     Valid states are "idle", "failure", "association", "configuration", "ready", "disconnect" and "online".
 */
const WIFI_STATES = {
  IDLE: 'idle',
  FAILURE: 'failure',
  ASSOCIATION: 'association',
  CONFIGURATION: 'configuration',
  READY: 'ready',
  DISCONNECT: 'disconnect',
  ONLINE: 'online',
  CONNECTING: 'connecting', //--extra
  UNKNOWN: 'unkown' //--extra
};

const HOTSPOT_STATES = {
  UNKNOWN: 'unknown',
  CREATING_FAILED: 'creatingFailed',
  DISABLED: 'disabled',
  CREATING: 'creating',
  ENABLED: 'enabled'
};

module.exports = WiFi;
module.exports.WIFI_STATES = WIFI_STATES;

function WiFi(connman) {
  _self = this;
  _connman = connman;
  _self.logNetworksOnChange = false;
}

util.inherits(WiFi, EventEmitter);

WiFi.prototype.init = function(hotspotSSID,hotspotPassphrase,callback) {
  debug("init: ",hotspotSSID,hotspotPassphrase);
  _self = this;
  _hotspotSSID = hotspotSSID;
  _hotspotPassphrase = hotspotPassphrase;
  // Retrieve WiFi technology
  // https://kernel.googlesource.com/pub/scm/network/connman/connman/+/1.14/doc/technology-api.txt
  _tech = _connman.technologies.WiFi;
  if(_tech === undefined) {
    if(callback) callback(new Error("No WiFi hardware available"));
    return;
  }
  _available = true;
  _self.getProperties(function(err, properties) {
    if(err) {
      if(callback) callback(err); 
      return;
    }
    _techProperties = properties;
    if(properties.Powered) { // already powered? 
      if(callback) callback(null,properties);
      return;
    }
    _self.enable(function(err) {
      if(callback) callback(err,properties);
    });
  });
  // Monitor manager and technogy API
  _connman.on('PropertyChanged',onManagerPropertyChanged);
  _connman.on('ServicesChanged',onServicesChanged);
  _tech.on('PropertyChanged',onTechPropertyChanged);
  
  // Get current services (networks) 
  _tech.getServices(function(err,services) {
    //debug("_connman.getServices respone: ",arguments);
    if(err) return debug("[Warning] Coulnd't get current services: ",err);
    setNetworks(parseServices(services),false);
  });
  // Monitor current service (network) 
  getCurrentService(function(err,service) {
    if(err) return;
    setService(service);
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
  _tech.setProperty(type, value, function(err) {
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
  _tech.getProperties(callback);
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
        setNetworks(parseServices(services),false);
        callback(null, _networks);
      });
    });
  },callback);
};
WiFi.prototype.scan = function(callback) {
  debug("scan");
  if(_techProperties.Tethering) {
    debug("[Warning] Scanning while in tethering mode is usually not supported");
  }
  _tech.scan(function(err) {
    if(err) {
      debug("[Error] scanning: ",err);
      if(err.message == 'org.freedesktop.DBus.Error.NoReply') {
        debug("[Error] Scan failed, probably because I'm a hotspot / tethering");
      }
    }
    if(callback) callback(err);
  });
};
WiFi.prototype.join = function(ssid,passphrase,callback) {
  debug("join: ",ssid,passphrase);
  if(ssid === undefined) {
    if(callback) callback(new Error("ssid is required"));
    return;
  }
  passphrase = passphrase || '';
  var targetService; 
  var targetServiceData; 
  async.series([
    _self.closeHotspot,
    function doGetService(next) { 
      //debug("doGetService: ",ssid);
      async.retry(_numGetServiceRetries, function(nextRetry) {
        //debug("(re)attempt getService");
        getServiceBySSID(ssid,function(err,service,serviceData) {
          //debug("getService response: ",err,service);
          if(err) return setTimeout(nextRetry, _getServiceRetryTimeout, err);
          targetService = service;
          targetServiceData = serviceData;
          next();
        });
      },next);
    },
    function doHandleSecurity(next) {
      if (targetServiceData.Security.indexOf('none') > -1) {
        debug('[NOTE] this is an open network');
        return next();
      }
      debug('[NOTE] this network is protected with: ' + _service.Security);
      if(passphrase === '') {
        next(); // ToDo also store empty password? 
      } else {
        storePassphrase(ssid,passphrase,next);
      }
    },
    // Hostmodule has a disconnect here, not sure why...
    function switchService(next) {
      setService(targetService);
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
          case WIFI_STATES.READY:
          case WIFI_STATES.ONLINE:
  //          self.connman.getOnlineService(function(err, _service) {
  //            if (_service.Type === 'ethernet' && _service.State === 'online') {
  //              if (self.wifiState !== WIFI_STATES.ONLINE) {
  //                debug('[NOTE] online through ethernet');
  //                self._updateEthernetState(ETHERNET_STATES.ONLINE);
  //              }
  //            }
  //          });
            _service.removeListener('PropertyChanged',onChange);
            next();
            break; 
          case WIFI_STATES.FAILURE:
            var err = new Error("Joining network failed (wrong password?)");
            debug('[FAILURE] ',err);
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
      _self.join(favoriteAP.ssid,'',function(err) {
        //debug('join response: ',err || '');
        if(err) return next(err);
        if(callback) callback(err);
      });
    }
  ], function(err) {
    debug('joinFavorite series finished');
    if(err) {
      debug("[ERROR] joining network: ",err);
     if(callback) callback(err); 
    }
  });
};
WiFi.prototype.disconnect = function(callback) {
  debug("disconnect");
  getCurrentService(function(err,service) {
    if(err) {
      if(callback) callback(err);
      return;
    }
    _service.disconnect(function(err) {
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
WiFi.prototype.closeHotspot = function(callback) {
  debug("closeHotspot");
  // monitor tech's property changed to know when tethering is disabled
  function localTechOnProperyChanged(type,value) {
    if(type == 'Tethering' && value === false) {
      if(callback) callback();
      _tech.removeListener('PropertyChanged',localTechOnProperyChanged);
    }
  }
  _tech.on('PropertyChanged',localTechOnProperyChanged);
  
  _tech.disableTethering(function(err, res) {
    //verbose("disableTethering response: ",err,res);
    if (err) {
      // not reporting already disabled as error
      if (err.message === 'net.connman.Error.AlreadyDisabled') {
        debug('[NOTE] Hotspot already closed');
        err = null;
      } 
      _tech.removeListener('PropertyChanged',localTechOnProperyChanged);
      if (callback) callback(err);
      return;
    }
  });
};
WiFi.prototype.openHotspot = function(ssid,passphrase,callback) {
  ssid               = ssid       || _hotspotSSID;
  passphrase         = passphrase || _hotspotPassphrase;
  _hotspotSSID       = ssid;
  _hotspotPassphrase = passphrase;
  debug("openHotspot: ",ssid,passphrase);
  
  // changing ssid or passphrase works while already hotspot? 
  // see: https://01.org/jira/browse/CM-668
  _tech.enableTethering(ssid, passphrase, function(err, res) {
    //debug("enableTethering response: ",err,res);
    if(err && err.message === 'net.connman.Error.PassphraseRequired') {
      err = new Error("Invalid password (passphrase must be at least 8 characters) (connman: "+err+")");
    }
    if(err) debug("[ERROR] openHotspot failed: ",err);
    if (callback) callback(err);
  });
};
WiFi.prototype.getAvailable = function() {
  return _available;
};

function onManagerPropertyChanged(type, value) {
  verbose("manager property changed: "+type+": ",value);
}
function onServicesChanged(changes,removed) {
  var numNew = 0;
  for(var key in changes) {
    if(Object.keys(changes[key]).length > 0) { // not empty
      numNew++;
    }
  }
  verbose("ServicesChanged: added: "+numNew+" removed: "+Object.keys(removed).length);
  
  // Future: emit per removed network a networkRemoved event
  // Future: emit per added network a networkAdded event
  
  _tech.getServices(function(err,services) {
    setNetworks(parseServices(services),true);
  });
}
function onTechPropertyChanged(type, value) {
  //verbose("tech property changed: "+type+": ",value);
  _techProperties[type] = value;
  _self.emit(type,value);
  logStatus();
}
function onServicePropertyChanged(type, value) {
  //verbose("service property changed: "+type+": ",value);
  _serviceProperties[type] = value;
  _self.emit(type,value);
  switch(type) {
    case 'State':
    case 'Name':
    case 'Security':
    case 'IPv4':
      logStatus();
      break;
  }
}

function parseServices(raw) {
  var parsed = {};
  for (var key in raw) {
    var service = parseService(raw[key]);
    if(parseService.state === 'failure') continue;
    parsed[key] = service;
  }
  return parsed;
}
function parseService(rawService) {
  var service = {};
  
  var include = ["State","Strength","Security","Favorite","Immutable","AutoConnect"];
  
  for (var propType in rawService) {
    if(include.indexOf(propType) === -1) continue;
    service[propType.toLowerCase()] = rawService[propType];
  }
  service.ssid = String(rawService.Name ? rawService.Name : '*hidden*');
  return service;
}
function setService(service) {  
  if(_service) _service.removeAllListeners();
  _service = service;
  // get properties (logStatus)
  _service.getProperties(function(err, props) {
    //debug("new service properties: ",props);
    _serviceProperties = parseService(props);
    for(var type in _serviceProperties) {
      _self.emit(type,_serviceProperties[type]); //ToDo lowercase
    }
    logStatus();
  });
  // listen for property changes
  _service.on('PropertyChanged', onServicePropertyChanged);
  // ToDo: broadcast event? 
}
function setNetworks(networks,onchange) {
  _networks = networks;
  logNetworks(onchange);
  // emit networks list as array
  var networksArr = [];
  for (var key in _networks) {
      networksArr.push(_networks[key]);
  }
  _self.emit('networks',networksArr);
}
function getCurrentService(callback) {
  _tech.getServices(function(err, services) {
    var connectedServiceName;
    for(var serviceName in services){
      var serviceData = services[serviceName];
      if(serviceData.State === 'ready' || serviceData.State === 'online') {
        connectedServiceName = serviceName;
        break;
      }
    }
    if(!connectedServiceName) {
      return callback(new Error("Not connected to any wifi services"));
    }
    //debug("connectedServiceName: ",serviceName);
    _connman.getService(connectedServiceName, function(err, service) {
      _service = service;
      callback(err,service);
    });
  });
}
function getServiceBySSID(ssid,callback) {
  debug("getService: ",ssid);
  _tech.getServices(function(err, services) {
    if(err) return next(err);
    for(var serviceName in services) {
      if(services[serviceName].Name == ssid) {
        serviceData = services[serviceName];
        debug("found network '"+ssid+"'");
        break;
      }
    }
    if (!serviceData) {
      return callback(new Error("Network '"+ssid+"' not found"));
    }
    _connman.getService(serviceData.serviceName, function(err, service) {
      callback(err,service,serviceData); 
    });
  });
}
function storePassphrase (ssid, passphrase, callback) {
  debug("storePassphrase: ",ssid,passphrase);
  var ssidHex = stringToHex(ssid);
  var path = '/var/lib/connman/network-' + ssidHex + '.config';
  var writeBuffer = new Buffer(
    '[service_' + ssid + ']\n' +
    'Type = wifi\n' +
    'SSID = ' + ssidHex + '\n' +
    'Passphrase = ' + passphrase + '\n'
  );
  fs.open(path, 'w', function(err, fd) {
    if (err) {
      if (callback) callback(err);
      return;
    }
    fs.write(fd, writeBuffer, 0, writeBuffer.length, null, function(err) {
      if (err) {
        if (callback) callback(err);
        return;
      }
      fs.close(fd, function() {
        if (callback) callback(null, {
          message: 'stored passphrase [' + passphrase + '] for [' + ssid + '] with ssidHex [' + ssidHex + '] in /var/lib/connman/'
        });
      });
    });
  });
}
function stringToHex(tmp) {
  function d2h(d) {
    return d.toString(16);
  }
  var str = '', i = 0, tmpLen = tmp.length;
  for (; i < tmpLen; i += 1) {
    str += d2h(tmp.charCodeAt(i)) + '';
  }
  return str;
}
function hexToString(tmp) {
  function h2d(h) {
    return parseInt(h, 16);
  }
  var arr = tmp.split(' '), str = '', i = 0, arrLen = arr.length;
  for (; i < arrLen; i += 1) {
    str += String.fromCharCode(h2d(arr[i]));
  }
  return str;
}
function logStatus() {
  var techProps = _techProperties;
  var serviceProps = _serviceProperties;
  
  if(serviceProps && serviceProps.State){
    var connectionStatus = 'connection status: ';
    connectionStatus += (techProps.Connected)? "Connected" : "Disconnected"; 
    connectionStatus += " "+serviceProps.State;
    connectionStatus += " '"+serviceProps.Name+"'";
    connectionStatus += " "+serviceProps.Security;
    if(serviceProps.IPv4 && serviceProps.IPv4.Address) {
      connectionStatus += " "+serviceProps.IPv4.Address;
    }
    debug(connectionStatus);
  }
  if(techProps && techProps.Tethering) {
    debug('tethering: ',techProps.TetheringIdentifier,techProps.TetheringPassphrase);
  }
}
function logNetworks(onChange) {
  if(onChange && !_self.logNetworksOnChange) return;
  var states = {online: 'O', 
                 ready: 'R', 
                 association: 'a', 
                 configuration: 'c', 
                 disconnecting: 'd',
                 idle: ' ',
                 failure: 'x'};
  debug('Networks: ');
  for(var serviceName in _networks) {
    var network = _networks[serviceName];
    var networkLine = network.favorite? '*' : ' ';
    networkLine += network.autoconnect? 'A' : ' '; 
    networkLine += states[network.state];
    networkLine += " '"+network.ssid+"'";
    debug(networkLine,network.security);
  }
}