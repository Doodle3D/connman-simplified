'use strict';

var debug = require('debug')('connman-simplified:wifi');
var async = require('async');
var util = require("util");
var Base = require('./Base');
var ms = require('ms');
var configFiles = require('./ConfigFiles.js');
var Parser = require('./Parser');

var _super = Base.prototype;

var _timeoutWiFiEnable = 3000;
var _numGetServiceAttempts = 5;
var _getServiceAttemptTimeout = 1000;
var _numGetServicesAttempts = _numGetServiceAttempts;
var _getServicesAttemptTimeout = _getServiceAttemptTimeout;
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
  //debug("init");
  var self = this;
  // Retrieve WiFi technology
  // https://kernel.googlesource.com/pub/scm/network/connman/connman/+/1.14/doc/technology-api.txt
  var tech = self.connman.technologies.WiFi;
  if (tech === undefined) {
    if (callback) callback(new Error('No WiFi hardware available'));
    return;
  }
  _super.init.call(self,tech,function(err, properties) {
    if (properties.powered) { // already powered?
      if (callback) callback(err,properties);
    } else {
      self.enable(function(err) {
        if (callback) callback(err,properties);
      });
    }
  });
  self.on('services',onServices);
};
WiFi.prototype.enable = function(callback) {
  this.setProperty('Powered', true, function(err) {
    // Sometimes this failes, our hypothesis is that
    // this is usually caused by a shortage of power
    if (err) {
      debug('[Error] Enabling wifi failed: ',err);
    }
    // delay, probably because of: https://01.org/jira/browse/CM-644
    setTimeout(callback, _timeoutWiFiEnable, err);
  });
};
WiFi.prototype.disable = function(callback) {
  this.setProperty('Powered', false, callback);
};

/* Get available networks
 * goal of this method is to return a good amount of networks
 * therefore there is a attempts and timeout system build in
 */
WiFi.prototype.getNetworks = function(callback) {
  var self = this;
  var attempt = 0;

  self.scan(); // start scan, but don't wait for it
  setTimeout(function() { // wait a moment before retrieving services
    async.retry(_numGetServicesAttempts, function(nextRetry) {
      debug('search services attempt: ',++attempt,'/',_numGetServicesAttempts);
      self.iface.getServices(function(err, services) {
        if (!err && Object.keys(services).length === 0) {
          err = new Error('No WiFi networks found');
        }
        if (err) {
          debug('getServices err: ',err);
          self.scan(); // start scan, but don't wait for it
          return setTimeout(nextRetry, _getServicesAttemptTimeout, err); // try again
        }
        self._setServices(Parser.parseServices(services));
        var servicesArr = self._obj2Arr(self.services);
        callback(null, servicesArr);
      });
    },callback);
  },_getServicesAttemptTimeout);
};
WiFi.prototype.getNetworksCache = function(callback) {
  debug('getNetworksCache');
  var servicesArr = this._obj2Arr(_servicesCache);
  callback(null, servicesArr);
};
WiFi.prototype.scan = function(switchTethering, callback) {
  var self = this;
  if (typeof switchTethering === 'function') {
    callback = switchTethering;
    switchTethering = false;
  }
  debug('scan ' + (switchTethering ? '& switchTethering' : ''));

  if (self.properties.tethering && !switchTethering) {
    debug('[Warning] Scanning while in tethering mode is usually not supported');
  }

  // Because our hardware can't scan and tether at the same time we
  // might need to switch off tethering, scan and start tethering again
  // ToDo: research wheter it's possible to keep the hotspot clients connected
  if (self.properties.tethering && switchTethering) {
    var startTime = Date.now();
    self.closeHotspot(function(err) {
      if (err) {
        if (callback) callback(err);
        return;
      }
      self.iface.scan(function() { // ToDo: add retries?
        //logNetworks();
        self.openHotspot(null,null,function(err) {
          debug('switchTethering time: ',ms(Date.now() - startTime));
          if (callback) callback(err);
        });
      });
    });
  } else {
    self.iface.scan(function(err) {
      if (err) {
        debug('[Error] scanning: ',err); // ToDo: remove?
        if (err.message === 'org.freedesktop.DBus.Error.NoReply') {
          debug("[Error] Scan failed, probably because I'm a hotspot / tethering");
        }
      }
      if (callback) callback(err);
    });
  }
};
WiFi.prototype.join = function(ssid, passphrase, callback) {
  var self = this;
  debug('join: ',ssid);
  if (ssid === undefined) {
    if (callback) callback(new Error('ssid is required'));
    return;
  }
  if (typeof passphrase === 'function') {
    callback = passphrase;
    passphrase = '';
  }
  var targetService;
  var targetServiceProperties;
  async.series([
    // close hotspot
    self.closeHotspot.bind(self),
    // find service / network
    function(next) {
      getServiceBySSID.call(self,ssid,function(err, service, properties) {
        if (err) return next(err);
        targetService = service;
        targetServiceProperties = properties;
        next();
      });
    },
    // check current state
    function(next) {
      var connected = (targetServiceProperties.state === STATES.READY ||
                       targetServiceProperties.state === STATES.READY);
      if (connected) next(new Error('Already connected'));
      else next();
    },
    // handle security
    function(next) {
      var secured = targetServiceProperties.security.indexOf('none') === -1;
      if (!secured) return next(); // no security
      if (!passphrase || passphrase === '') {
        if (targetServiceProperties.favorite) next();
        else next(new Error('No passphrase supplied for secured network'));
      } else {
        configFiles.create(ssid,passphrase,next);
      }
    },
    // switch to this service
    function(next) {
      self._setService(targetService.name,targetServiceProperties);
      next();
    },
    // connect to service
    function(next) {
      targetService.connect(function(err, newAgent) {
        debug('connect response: ',err || ''/*,newAgent*/);
        next(err);
      });
    },
    // listen to state
    function(next) {
      function onChange(type, value) {
        if (type !== 'State') return;
        debug("service State: ",value);
        switch (value) {
          // when wifi ready and online
          case STATES.READY:
          case STATES.ONLINE:
            targetService.removeListener('PropertyChanged',onChange);
            next();
            break;
          case STATES.FAILURE:
            var err = new Error('Joining network failed (wrong password?)');
            targetService.removeListener('PropertyChanged',onChange);
            next(err);
            // ToDo include error... (sometimes there is a Error property change, with a value like 'invalid-key')
            break;
        }
      }
      targetService.on('PropertyChanged', onChange);
    }
  ],function(err) {
    debug('join finished: ',err || '');
    if (callback) callback(err);
  });
};
WiFi.prototype.joinFavorite = function(callback) {
  debug('joinFavorite');
  var self = this;
  async.waterfall([
    // close hotspot
    self.closeHotspot.bind(self),
    // find favorite network
    getFavoriteService.bind(self),
    // join favorite network
    function(service, properties, next) {
      self.join(properties.ssid,next);
    }
  ], function(err) {
    debug('joinFavorite series finished: ',err || '');
    if (callback) callback(err);
  });
};
WiFi.prototype.disconnect = function(callback) {
  debug('disconnect');
  if (!this.service) {
    if (callback) callback(new Error('no service to disconnect from'));
    return;
  }
  this.service.disconnect(function(err) {
    if (callback) callback(err);
  });
};
WiFi.prototype.forgetNetwork = function(ssid, callback) {
  //ssid parameter is optional, might be callback function
  if (typeof ssid === 'function') {
    callback = ssid;
    debug('forget current network:' + this.serviceProperties.ssid);
    if (this.service) {
      this.service.remove();
      configFiles.remove(this.serviceProperties.ssid, callback);
      if (callback) callback();
    } else {
      if (callback) callback(new Error('no current service'));
    }
  } else {
    if (typeof ssid !== 'string') {
      if (callback) callback(new Error('provided ssid is not a string'));
      return;
    }
    debug('forgetNetwork: ',ssid);
    getServiceBySSID.call(this,ssid,function(err, service) {
      if (err) {
        if (callback) callback(err);
        return;
      }
      if (service) service.remove();
    });
    configFiles.remove(ssid,callback);
  }
};
WiFi.prototype.closeHotspot = function(callback) {
  debug('closeHotspot');
  var self = this;
  // Having changing the Tethering property doesn't mean the hotspot is closed.
  // A better indicator is listening to Tethering and Powered property changes
  // The Tethering changes to false, Powered is set to true (maybe the device restarts?)
  // But the best indicator seems to wait for the available services to change.
  function onChange(changes, removed) {
    if (callback) callback();
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
WiFi.prototype.openHotspot = function(ssid, passphrase, callback) {
  debug('openHotspot');
  var self = this;
  // changing ssid or passphrase works while already hotspot requires disable first
  // see: https://01.org/jira/browse/CM-668
  var args = arguments;
  if (self.properties.tethering) {
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
  if (!this.properties.tethering) {
    //debug('update servicesCache');
    _servicesCache = this.services;
  }  
}

/********************
 * Private functions
 ********************/
function getServiceBySSID(ssid, callback) {  
  searchService.call(this, {Name: ssid}, callback);
}
function getFavoriteService(callback) {
  searchService.call(this, {Favorite: true}, callback);
}
function searchService(query, numRetries, callback) {
  //debug('searchService query: ',query);
  if (typeof numRetries === 'function') {
    callback = numRetries;
    numRetries = _numGetServiceAttempts;
  }
  var self = this;
  var attempt = 0;
  async.retry(numRetries, function(nextRetry) {
    attempt++;
    debug('search service attempt: ',attempt,'/',numRetries);
    self.scan(); // start scan, but don't wait for it
    self.iface.searchService(query,function(err, service, properties) {
      if (err) setTimeout(nextRetry, _getServiceAttemptTimeout, err);
      else callback(err, service, Parser.parseService(properties));
    });
  },callback);
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
