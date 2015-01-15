var debug     = require('debug')('connman-tests');
var async     = require('async');
var keypress  = require('keypress');
var Connman   = require('../lib'); // connman-simplified
var connman   = Connman();

var ethernet;
var wifi;

keypress(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();

async.series([
  function initConnman(next) {
    
    debug('initializing connman...');
    connman.init(function(err) {
      if (err) {
        debug('[ERROR] connman init: ',err);
        return;
      }
      next();
    });
  },
  function initEthernet(next) {
    debug("initEthernet");
    connman.initEthernet(function(err,newEthernet,properties) {
      if(err) return debug("[ERROR] init ethernet: ",err);
      debug("ethernet properties: ",properties);
      ethernet = newEthernet;
    });
    next();
  },
  function initWiFi(next) {
    debug("initWiFi");
    connman.initWiFi(function(err,newWiFi,properties) {
      wifi = newWiFi;
      debug("wifi connected: ",properties.connected);
      debug("properties: ",properties);
      if(properties.connected) return next(); // already connected? 
      wifi.joinFavorite(function(err) {
        if(err) wifi.openHotspot(null,null,next);
        else next();
      });
    });
  }
],function(err) {
  debug("start seq finished: ",err || '');
  
  connman.on('state',function(value) {
    debug("Overall state: ",value);
  });
  wifi.on('state',function(value) {
    debug("WiFi state change: ",value);
    if(value === Connman.WiFi.WIFI_STATES.FAILURE) {
      wifi.openHotspot();
    }
  }); 
});

// listen for the "keypress" event
process.stdin.on('keypress', function (ch, key) {
  //debug('keypress: ', ch, key);
  var keyName = (key)? key.name : ch;
  debug("");
  debug(keyName+" > ");
  switch(keyName) {
    case 'c':
    case '1':
      if(keyName === 'c' && key.ctrl) process.exit(1);
      else wifi.join("Vechtclub XL F1.19",'groentegorilla');
      break;
    case '2':
      wifi.join("Vechtclub XL F1.19",'wrongpassword');
      break;
    case '3':
      wifi.join("hss","wrongpassword");
      break;
    case '4':
      wifi.join("hss");
      break;
    case '5':
      wifi.join("wrongnetwork",'wrongpassword');
      break;
    case '6':
      wifi.join("Doodle3D-wisp");
      break;
    case 'f': 
      wifi.joinFavorite();
      break;
    case 'd':
      wifi.disconnect(function(err) {
        if(err) debug("[Error] disconnect error: ",err);
      });
      break;
    case 'q':
      wifi.forgetNetwork('Vechtclub XL F1.19',function(err) {
        if(err) debug("forgetNetwork err: ",err);
      });
      break;
    case 'o':
    case '8':
      wifi.openHotspot();
      break;
    case '9':
      wifi.openHotspot("myultimaker","ultimaker");
      break;
    case '0':
      wifi.openHotspot("connmanTest","connmannpassword");
      break;
    case 'x':
      wifi.closeHotspot();
      break;
    case 's':
			if(key.shift) wifi.scan(true);
			else wifi.scan();
      break;
    case 'g':
			if(key.shift) {
				wifi.getNetworksCache(function(err,list) {
					if(err) return debug("[ERROR] get networks cache: ",err);
					debug("found cached networks: ",wifi.getServicesString(list));
				});
			} else {
				wifi.getNetworks(function(err,list) {
					if(err) return debug("[ERROR] get networks: ",err);
					debug("found networks: ",wifi.getServicesString(list));
				});
			}
      break;
    case 'i':
      wifi.getConnectionProperties(function(err,properties) {
        if(err) debug("[ERROR] get connection properties: ",err);
      });
      break;
    case 'l':
      wifi.logNetworksOnChange = !wifi.logNetworksOnChange;
      debug("logNetworksOnChange: ",wifi.logNetworksOnChange);
      break;
  }
});