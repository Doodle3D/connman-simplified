var debug           = require('debug')('connman-simplified:wifi');
var async           = require('async');
var util            = require("util");
var Base            = require('./Base');
var ms              = require('ms');
var configFiles     = require('./ConfigFiles.js');
var Parser          = require('./Parser');

var _super = Base.prototype;

var _timeoutWiFiEnable = 3000;
var _scanRetryTimeout = 1000; //5000;
var _numScanRetries = 5; //3;
var _getServiceRetryTimeout = _scanRetryTimeout;
var _numGetServiceRetries = _numScanRetries;
var _servicesCache = []; // cache of services, use while tethering

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
  this.connman = connman;
}

util.inherits(WiFi, Base);

WiFi.prototype.init = function(callback) {
  debug("init");
  var self = this;
  // Retrieve WiFi technology
  // https://kernel.googlesource.com/pub/scm/network/connman/connman/+/1.14/doc/technology-api.txt
  var tech = self.connman.technologies.WiFi;
  if(tech === undefined) {
    if(callback) callback(new Error("No WiFi hardware available"));
    return;
  }
  _super.init.call(self,tech,function(err,properties) {
    if(properties.powered) { // already powered? 
      if(callback) callback(err,properties);
    } else {
      self.enable(function(err) {
        if(callback) callback(err,properties);
      });
    }
  });
  self.on('services',onServices);
};
WiFi.prototype.enable = function(callback) {
  // Note: Hostmodule tries this 3 times?
  this.setProperty('Powered', true, function(err) {
    //debug("WiFi setProperty 'Powered' true response: ",err);
    // delay, probably because of: https://01.org/jira/browse/CM-644
    setTimeout(callback, _timeoutWiFiEnable, err);
  });
};
WiFi.prototype.disable = function(callback) {
  this.setProperty('Powered', false, callback);
};

WiFi.prototype.getNetworks = function(callback) {
  var self = this;
  async.retry(_numScanRetries, function(nextRetry) {
    self.scan(function(err) {
      if(err) return setTimeout(nextRetry, _scanRetryTimeout, err);
      self.iface.getServices(function(err,services) {
        //debug("listAccessPoints response: ",err,services);
        if(Object.keys(services).length === 0) {
          return setTimeout(nextRetry, _scanRetryTimeout, new Error('No WiFi networks found'));
        }
        self._setServices(Parser.parseServices(services));
        callback(null, self.services);
      });
    });
  },callback);
};
WiFi.prototype.getNetworksCache = function(callback) {
  debug("getNetworksCache");
  callback(null, _servicesCache);
};
WiFi.prototype.scan = function(switchTethering,callback) {
  var self = this;
  if(typeof switchTethering == 'function') {
    callback = switchTethering;
    switchTethering = false;
  }
  debug("scan "+(switchTethering? '& switchTethering' : ''));
  
  if(self.properties.tethering && !switchTethering) {
    debug("[Warning] Scanning while in tethering mode is usually not supported");
  }
  
  // Because our hardware can't scan and tether at the same time we 
  // might need to switch off tethering, scan and start tethering again
  // ToDo: research wheter it's possible to keep the hotspot clients connected
  if(self.properties.tethering && switchTethering) {
    var startTime = Date.now();
    self.closeHotspot(function(err) {
      self.iface.scan(function() { // ToDo: add retries?
        //logNetworks();
        self.openHotspot(null,null,function(err) {
          debug('switchTethering time: ',ms(Date.now()-startTime));
          if(callback) callback(err);
        });
      });
    });
  } else {
    self.iface.scan(function(err) {
      if(err) {
        debug("[Error] scanning: ",err); // ToDo: remove? 
        if(err.message == 'org.freedesktop.DBus.Error.NoReply') {
          debug("[Error] Scan failed, probably because I'm a hotspot / tethering");
        }
      }
      if(callback) callback(err);
    });
  }
};
WiFi.prototype.join = function(ssid,passphrase,callback) {
  var self = this;
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
    self.closeHotspot.bind(self),
    function doGetService(next) { 
      //debug("doGetService: ",ssid);
      async.retry(_numGetServiceRetries, function(nextRetry) {
        //debug("(re)attempt scan & getService");
        self.scan(); // start scan, but don't wait for it
        getServiceBySSID.call(self,ssid,function(err,service,properties) {
          //debug("getService response: ",err,service);
          if(err) return setTimeout(nextRetry, _getServiceRetryTimeout, err);
          targetService = service;
          targetServiceProperties = properties;
          next();
        });
      },next);
    },
    function doCheckState(next) {
      switch(targetServiceProperties.state) {
        case STATES.READY:
        case STATES.ONLINE:
          next(new Error('Already connected'));
          break;
        default:
          next();
        break;
      }
    },    
    function doHandleSecurity(next) {
      if (targetServiceProperties.security.indexOf('none') > -1) {
        debug('[NOTE] this is an open network');
        return next();
      }
      debug('[NOTE] this network is protected with: ' + targetServiceProperties.security);
      if(!passphrase || passphrase === '') {
        if(targetServiceProperties.favorite) next();
        else next(new Error("No passphrase supplied for secured network"));
      } else {
        configFiles.create(ssid,passphrase,next);
      }
    },
    function switchService(next) {
      self._setService(targetService.name,targetServiceProperties);
      next();
    },
    function doConnect(next) {
      targetService.connect(function(err, newAgent) {
        debug("connect response: ",err || ''/*,newAgent*/);
        next(err);
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
            targetService.removeListener('PropertyChanged',onChange);
            next();
            break; 
          case STATES.FAILURE:
            var err = new Error("Joining network failed (wrong password?)");
            targetService.removeListener('PropertyChanged',onChange);
            next(err);
            // ToDo include error... (sometimes there is a Error property change, with a value like 'invalid-key')
            break;
        }
      }
      targetService.on('PropertyChanged',onChange);  
    }
  ],function(err) {
    debug('join finished: ',err || '');
    if(callback) callback(err);
  });
};
WiFi.prototype.joinFavorite = function(callback) {
  debug("joinFavorite");
  var self = this;
  var favoriteAP;
  async.series([
    self.closeHotspot.bind(self),
    function doFindFavoriteNetwork(next) {
      self.getNetworks(function(err,list) {
        if(err) return next(err);
        for (var index in list) {
          var ap = list[index];
          if(ap.favorite) {
            favoriteAP = ap;
            return next();
          }
        } 
        err = new Error("No favorite network found");
        next(err);
      });
    },
    function doConnect(next) {
      //--join favorite, passphrase: '' because a) open network, b) known /var/lib/connman/network- file
      self.join(favoriteAP.ssid,function(err) {
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
  this.service.disconnect(function(err) {
    if(callback) callback(err);
  });
};
WiFi.prototype.forgetNetwork = function(ssid,callback) {
  debug('forgetNetwork: ',ssid);
  
  getServiceBySSID.call(this,ssid,function(err,service) {
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
  var self = this;
  // Having changing the Tethering property doesn't mean the hotspot is closed. 
  // A better indicator is listening to Tethering and Powered property changes
  // The Tethering changes to false, Powered is set to true (maybe the device restarts?)
  // But the best indicator seems to wait for the available services to change.
  function onChange(changes,removed) {
    if(callback) callback();
    self.removeListener('servicesChanged',onChange);
  }  
  self.on('servicesChanged',onChange);
  
  self.iface.disableTethering(function(err, res) {
    //debug("disableTethering response: ",err,res);
    if (err) {
      // not reporting already disabled as error
      if (err.message === 'net.connman.Error.AlreadyDisabled') {
        debug('[NOTE] Hotspot already closed');
        err = null;
      } 
      self.removeListener('servicesChanged',onChange);
      if (callback) callback(err);
      return;
    }
  });
};
WiFi.prototype.openHotspot = function(ssid,passphrase,callback) {
  debug("openHotspot");  
  var self = this;
  // changing ssid or passphrase works while already hotspot requires disable first
  // see: https://01.org/jira/browse/CM-668
  var args = arguments;
  if(self.properties.tethering) {
    self.closeHotspot(function() {
      self.iface.enableTethering.apply(self.iface,args);
    });
  } else {
    self.iface.enableTethering.apply(self.iface,args);
  }
};

/********************
 * Event handlers
 ********************/
function onServices() {
  if(!this.properties.tethering) {
    //debug('update servicesCache');
    _servicesCache = this.services;
  }  
}

/********************
 * Private functions
 ********************/
function getServiceBySSID(ssid,callback) {
  this.iface.searchService({Name:ssid},function(err,service,properties) {
    if(err) callback(err); 
    else callback(null, service, Parser.parseService(properties)); 
  });
}

//function logStatus() {
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
//}
