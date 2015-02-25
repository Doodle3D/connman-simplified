'use strict';

var debug = require('debug')('connman-simplified:wifi');
var async = require('async');
var util = require('util');
var Base = require('./Base');
var ms = require('ms');
var configFiles = require('./ConfigFiles.js');
var Parser = require('./Parser');

var _super = Base.prototype;

var _timeoutWiFiEnable = 3000;
var _numGetServiceAttempts = 5;
var _timeoutServicesChanged = 5000;
var _numServicesChangedEvents = 2;
var _getServiceAttemptTimeout = 1000;
var _numGetServicesAttempts = _numGetServiceAttempts;
var _getServicesAttemptTimeout = _getServiceAttemptTimeout;
var _servicesCache = []; // cache of services, use while tethering

var _openingHotspot = false;
var _closingHotspot = false;
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
  _super.init.call(self, tech, function(err, properties) {
    if (properties.powered) { // already powered?
      if (callback) callback(err, properties);
    } else {
      self.enable(function(err) {
        if (callback) callback(err, properties);
      });
    }
  });
  self.on('services', onServices);
};
WiFi.prototype.enable = function(callback) {
  this.setProperty('Powered', true, function(err) {
    // Sometimes this failes, our hypothesis is that
    // this is usually caused by a shortage of power
    if (err) {
      debug('[Error] Enabling wifi failed: ', err);
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
  self.scan(false, function(err) {
    var servicesArr = self._obj2Arr(self.services);
    if (callback) callback(err, servicesArr);
  });
};
WiFi.prototype.getNetworksForceFresh = function(callback) {
  var self = this;
  self.scan(true, function(err) {
    var servicesArr = self._obj2Arr(self.services);
    if (callback) callback(err, servicesArr);
  });
};
WiFi.prototype.getNetworksCache = function(callback) {
  debug('getNetworksCache');
  var servicesArr = this._obj2Arr(_servicesCache);
  if (callback) callback(null, servicesArr);
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
      self.scan(false, function() {
        self.openHotspot(null, null, function(err) {
          debug('switchTethering time: ', ms(Date.now() - startTime));
          if (callback) callback(err);
        });
      });
    });
  } else {
    self.iface.scan(function(err) {
      if (err) {
        debug('[Error] scanning: ', err); // ToDo: remove?
        if (err.message === 'org.freedesktop.DBus.Error.NoReply') {
          debug("[Error] Scan failed, probably because I'm a hotspot / tethering");
        }
      }

      awaitServices.call(self, function (err) {
        if (callback) callback(err);
      });
    });
  }
};

WiFi.prototype.join = function(ssid, passphrase, callback) {
  var self = this;
  debug('join: ', ssid);
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
      getServiceBySSID.call(self, ssid, function(err, service, properties) {
        if (err) return next(err);
        targetService = service;
        targetServiceProperties = properties;
        next();
      });
    },
    // check current state
    function(next) {
      // already connected to service? stop
      if (targetServiceProperties.state === STATES.READY ||
          targetServiceProperties.state === STATES.ONLINE) {
        debug('already connected');
        if (callback) callback();
        return;
      } else {
        next();
      }
    },
    // handle security
    function(next) {
      var secured = targetServiceProperties.security.indexOf('none') === -1;
      if (!secured) return next(); // no security
      if (!passphrase || passphrase === '') {
        if (targetServiceProperties.favorite) next();
        else next(new Error('No passphrase supplied for secured network'));
      } else {
        configFiles.create(ssid, passphrase, next);
      }
    },
    // switch to this service
    function(next) {
      self._setService(targetService.name, targetServiceProperties);
      next();
    },
    // connect to service
    function(next) {
      targetService.connect(function(err, newAgent) {
        debug('connect response: ', err || ''/*,newAgent*/);
        next(err);
      });
    },
    // listen to state
    function(next) {
      function onChange(type, value) {
        if (type !== 'State') return;
        debug('service State: ', value);
        switch (value) {
          // when wifi ready and online
          case STATES.READY:
          case STATES.ONLINE:
            targetService.removeListener('PropertyChanged', onChange);
            next();
            break;
          case STATES.FAILURE:
            var err = new Error('Joining network failed (wrong password?)');
            targetService.removeListener('PropertyChanged', onChange);
            next(err);
            // ToDo include error... (sometimes there is a Error property change, with a value like 'invalid-key')
            break;
        }
      }
      targetService.on('PropertyChanged', onChange);
    }
  ], function(err) {
    debug('join finished: ', err || '');
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
      self.join(properties.ssid, next);
    }
  ], function(err) {
    debug('joinFavorite series finished: ', err || '');
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
    debug('forgetNetwork: ', ssid);
    getServiceBySSID.call(this, ssid, function(err, service) {
      if (err) {
        if (callback) callback(err);
        return;
      }
      if (service) service.remove();
    });
    configFiles.remove(ssid, callback);
  }
};
WiFi.prototype.closeHotspot = function(callback) {
  debug('closeHotspot');

  if (_closingHotspot) {
    if (callback) callback(new Error('Already closing hotspot'));
    return;
  };
  _closingHotspot = true;

  var self = this;
  // Having changing the Tethering property doesn't mean the hotspot is closed.
  // A better indicator is listening to Tethering and Powered property changes
  // The Tethering changes to false, Powered is set to true (maybe the device restarts?)
  // But the best indicator seems to wait for the available services to change.
  function onChange(changes, removed) {
    if (callback) callback();
    self.removeListener('servicesChanged', onChange);
  }
  self.on('servicesChanged', onChange);

  function onTetheringChange(tethering) {
    debug('hotspot onTetheringChange: ', tethering);
    if (!tethering) {
      _closingHotspot = false;
      debug('calling callback from onchange');
      if (callback) callback();
      self.removeListener('tethering', onTetheringChange);
      callback = null; 
    };
  }
  self.on('tethering', onTetheringChange);

  self.iface.disableTethering(function(err, res) {
    //debug("disableTethering response: ",err,res);
    if (err) {
      // not reporting already disabled as error
      if (err.message === 'net.connman.Error.AlreadyDisabled') {
        debug('[NOTE] Hotspot already closed');
        err = null;
      }
      self.removeListener('servicesChanged', onChange);
      self.removeListener('tethering', onTetheringChange);
      _closingHotspot = false;
      if (callback) callback(err);
      return;
    }
  });
};
WiFi.prototype.openHotspot = function(ssid, passphrase, callback) {
  debug('openHotspot');

  if (_openingHotspot) {
    if (callback) callback(new Error('Already opening hotspot'));
  };
  _openingHotspot = true;

  var self = this;

  var ssid = (typeof arguments[0] === 'string')? arguments[0] : null;
  var passphrase = (typeof arguments[1] === 'string')? arguments[1] : null;
  var lastArgument = arguments[arguments.length-1];
  var callback = (typeof lastArgument === 'function')? lastArgument : null;

  function onChange() {
    _openingHotspot = false;
    if (callback) callback();
  }  
  self.once('servicesChanged',onChange);

  var args = [];
  if (ssid) args.push(ssid);
  if (passphrase) args.push(passphrase);
  function cb(err) {
    if (err) {
//      // not reporting already disabled as error
//      if (err.message === 'net.connman.Error.AlreadyDisabled') {
//        debug('[NOTE] Hotspot already closed');
//        err = null;
//      } 
      self.removeListener('servicesChanged',onChange);
      _openingHotspot = false;
      if (callback) callback(err);
    }
  }
  args.push(cb);
  
  // changing ssid or passphrase works while already hotspot requires disable first
  // see: https://01.org/jira/browse/CM-668
  if (self.properties.tethering) {
    self.closeHotspot(function() {
      self.iface.enableTethering.apply(self.iface, args);
    });
  } else {
    self.iface.enableTethering.apply(self.iface, args);
  }
};

/********************
 * Event handlers
 ********************/
function onServices() {
  //debug('onServices');
  var numServices = Object.keys(this.services).length;
  if (!this.properties.tethering && numServices > 0) {
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
    debug('search service attempt: ', attempt, '/', numRetries);
    self.scan(); // start scan, but don't wait for it
    self.iface.searchService(query, function(err, service, properties) {
      if (err) setTimeout(nextRetry, _getServiceAttemptTimeout, err);
      else callback(err, service, Parser.parseService(properties));
    });
  }, callback);
}
function awaitServices(callback) {
  /*** NOTE
   * When a scan is requested, it takes time for the network services to broadcast their existance.
   * This function waits for onChange of the servicesChanged event which arrives in chuncks.
   * If the onChange event does not receive various chuncks with networks, a timeout makes sure it does not get stuck here.
   */
  // debug('awaitServices...');
  var self = this;

  if (callback === undefined || typeof callback !== 'function') {
    debug('ERROR: callback is undefined or not a function');
    return;
  }

  var timeoutRequestManually = setTimeout(
    function() {
      // debug('awaitServices timeout: force getServices');
      self.removeListener('servicesChanged', onChange);
      self.iface.getServices(function(err, services) {
        if (!err && Object.keys(services).length === 0) {
          err = new Error('No WiFi networks found');
        }
        self._setServices(Parser.parseServices(services));
        if (callback) callback(err);
      });
    }
    , _timeoutServicesChanged);

  var counter = 0;
  function onChange(changes, removed) {
    counter++;
    // debug('awaitServices servicesChanged: ' + counter + ' / ' + _numServicesChangedEvents);
    if (counter === _numServicesChangedEvents) {
      counter = 0;
      clearTimeout(timeoutRequestManually);
      self.removeListener('servicesChanged', onChange);
      if (callback) callback();
    }
  }
  self.on('servicesChanged', onChange);
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
