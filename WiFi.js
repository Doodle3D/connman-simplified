const debug = require('debug')('connman-tests:wifi');
const async = require('async');
const fs = require('fs');

var _timeoutWiFiEnable = 3000;
var _timeoutTetherDisable = 4000;
var _scanRetryTimeout = 5000;
var _numScanRetries = 3;
var _getServiceRetryTimeout = _scanRetryTimeout;
var _numGetServiceRetries = _numScanRetries;
var _connMan;
var _tech;
var _service;
var _connection;
var _available = false;
var _networks = [];
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

module.exports = WiFi;
var _hotspotSSID;
var _hotspotPassphrase;

function WiFi(connMan) {
  _connMan = connMan;
}

WiFi.prototype.init = function(hotspotSSID,hotspotPassphrase,callback) {
  debug("init: ",hotspotSSID,hotspotPassphrase);
  _self = this;
  _hotspotSSID = hotspotSSID;
  _hotspotPassphrase = hotspotPassphrase;
  // Retrieve WiFi technology
  // https://kernel.googlesource.com/pub/scm/network/connman/connman/+/1.14/doc/technology-api.txt
  _tech = _connMan.technologies.WiFi;
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
    if(properties.Powered) { // already powered? 
      if(callback) callback(null,properties);
      return;
    }
    _self.enable(function(err) {
      if(callback) callback(err,properties);
    });
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
  _self.setProperty('Powered', false, function(err) {
    setTimeout(callback, _timeoutWiFiEnable, err); // ToDo: needed?
  });
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
WiFi.prototype.getNetworks = function(callback) {
  debug("getNetworks");
  // ToDo: check if tethering, if so we can't scan
  async.retry(_numScanRetries, function(nextRetry) {
    debug("attempt scan");
    _tech.scan(function(err) {
      debug("  scan response: ",err);
      if(err) {
        if(err.message == 'org.freedesktop.DBus.Error.NoReply') {
          debug("[Error] Scan failed, probably because I'm a hotspot / tethering");
        }
        return setTimeout(nextRetry, _scanRetryTimeout, err);
      }
      //debug("listAccessPoints");
      // ToDo research: Results will be signaled via the ServicesChanged signal from the manager interface.
      _tech.listAccessPoints(function(err, rawList) {
        //debug("listAccessPoints response: ",err,rawList);
        if(rawList.length === 0) {
          return setTimeout(nextRetry, _scanRetryTimeout, new Error('No access points found'));
        }
        _networks = parseNetworks(rawList);
        callback(null, _networks);
      });
    });
  },callback);
};
WiFi.prototype.join = function(ssid,passphrase,callback) {
  debug("join: ",ssid,passphrase);
  if(ssid === undefined) {
    if(callback) callback(new Error("ssid is required"));
    return;
  }
  passphrase = passphrase || '';
  // ToDo: update wifiSSID & wifiState
  async.series([
    _self.closeHotspot,
    function doGetService(next) { 
      debug("doGetService: ",ssid);
      //ToDO retries
      async.retry(_numGetServiceRetries, function(nextRetry) {
        debug("(re)attempt getService");
        getService(ssid,function(err,service) {
          //debug("getService response: ",err,service);
          if(err) return setTimeout(nextRetry, _getServiceRetryTimeout, err);
          _service = service;
          next();
        });
      },next);
    },
    function doHandleSecurity(next) {
      if (_service.Security.indexOf('none') > -1) {
        debug('[NOTE] this is an open network');
        return next();
      }
      debug('[NOTE] this network is protected with: ' + _service.Security);
      if(passphrase === '') {
        next();
      } else {
        storePassphrase(ssid,passphrase,next);
      }
    },
    // Hostmodule has a disconnect here, not sure why...
    function doGetConnections(next) {
      _connMan.getConnection(_service.serviceName, function(err, newConnection) {
        //debug("getConnection response: ",err,newConnection);
        if (err) return next(err);
        _connection = newConnection;
        next();
      });
    },
    function doConnect(next) {
      _connection.connect(function(err, newAgent) {
        //debug("connect response: ",err,newAgent);
        if (err) return next(err);
        agent = newAgent;
        next();
      });
    },
    function doListen(next) {
      _connection.getProperties(function(err, props) {
        debug("connection properties: ",props);
        // ToDo update wifi...
      });
      _connection.on('PropertyChanged', onWiFiPropertyChanged);
      next();
    }
  ],function(err,results) {
    debug('join finished: ',err,results);
  });
};
WiFi.prototype.joinFavorite = function(callback) {
  debug("joinFavorite");
  var favoriteAP;
  async.series([
    _self.closeHotspot,
    function doFindFavoriteNetwork(next) {
      debug('doFindFavoriteNetwork');
      _self.getNetworks(function(err,list) {
        if(err) return next(err);
        debug("found networks: ",list);
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
      debug('doConnect');
      //--join favorite, passphrase: '' because a) open network, b) known /var/lib/connman/network- file
      _self.join(favoriteAP.ssid,'',function(err) {
        if(err) return next(err);
        if(callback) callback(err);
      });
      return;
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
  _tech.getServices(function(err, services) {
    var readyServiceName;
    for(var serviceName in services){
      var service = services[serviceName];
      if(service.State === 'ready') {
        readyServiceName = serviceName;
        break;
      }
    }
    if(!readyServiceName) {
      if(callback) callback(new Error("Not connected to any wifi services"));
      return;
    }
    //debug("readyServiceName: ",serviceName);
    _connMan.getConnection(readyServiceName, function(err, connection) {
      connection.disconnect(function(err) {
        //debug("disconnect response: ",err);
        if (err) {
          if (callback) callback(err);
          return;
        }
        // ToDo update wifiState?
        debug('disconnected from ' + serviceName + '...');
        if(callback) callback();
      });
    });
  });
};
WiFi.prototype.closeHotspot = function(callback) {
  debug("closeHotspot");
  _tech.disableTethering(function(err, res) {
    //debug("disableTethering response: ",err,res);
    if (err) {
      // not reporting already disabled as error
      if (err.message === 'net.connman.Error.AlreadyDisabled') {
        debug('[NOTE] Hotspot already closed');
        err = null;
      } 
      if (callback) callback(err);
      return;
    }
    setTimeout(function() {
      // ToDo: update hotspotSSID
      // ToDo: update hotspotState
      if (callback) callback();
    },_timeoutTetherDisable);
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
WiFi.prototype.isHotspot = function(callback) {
  _self.getProperty('Tethering',function(err,value) {
    debug("getProperty('Tethering' response: ",err,value);
    debug("typeof value: ",typeof value);
    return callback(err,value);
  });
};

WiFi.prototype.getAvailable = function() {
  return _available;
};
function onWiFiPropertyChanged(name, value) {
  debug(name+" changed: ",value);
          
  switch(name) {
    case 'Strength': 
      // ToDo update wifiStrength
      break;
    case 'State':
      // ToDo update wifiState
      switch(value) {
        // when wifi ready and online through ethernet
        case WIFI_STATES.READY:
//          self.connman.getOnlineService(function(err, _service) {
//            if (_service.Type === 'ethernet' && _service.State === 'online') {
//              if (self.wifiState !== WIFI_STATES.ONLINE) {
//                debug('[NOTE] online through ethernet');
//                self._updateEthernetState(ETHERNET_STATES.ONLINE);
//              }
//            }
//          });
          break; 
        case WIFI_STATES.FAILURE:
          debug('[FAILURE] WiFi connection failure, open hotspot');
          _self.openHotspot(); // ToDo: Shouldn't this be decided by libray/module user?
          break;
      }
      break;
  }
}
function parseNetworks(rawList) {
  var list = [];
  for (var index in rawList) {
    var rawAP = rawList[index];
    if(rawAP.State === 'failure') continue;
    var ap = {
      ssid: String((rawAP.Name ? rawAP.Name : '*hidden*')),
      // ssidHex: serviceNameArr[2], //--arr index 2 is ssidhex
      state: rawAP.State,
      strength: rawAP.Strength,
      security: rawAP.Security,
      favorite: rawAP.Favorite,
      immutable: rawAP.Immutable,
      autoConnect: rawAP.AutoConnect
    };
    list.push(ap);
  }
  return list;
}
function getService(ssid,callback) {
  debug("getService: ",ssid);
  _tech.findAccessPoint(ssid, function(err, service) {
    //debug("findAccessPoint response: ",err,service);
    if(err) {
      if (callback) callback(err);
      return;
    }
    if (!service) {
      if(callback) callback(new Error("Network '"+ssid+"' not found"))
      return;
    }
    //debug("service: ",service);
    if (callback) callback(null,service);
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
};