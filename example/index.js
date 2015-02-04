var debug     = require('debug')('example');
var async     = require('async');
var keypress  = require('keypress');
var Connman   = require('../lib'); // connman-simplified
var connman   = Connman();

var ethernet;
var wifi;
var targetNetworks = [];
var logNetworksOnChange = false; 

keypress(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();

retrieveEnvVars();

if(!process.env.DEBUG) {
  console.log("Use $DEBUG=* to view all logs");
}
debug(getHelpText());

async.series([
  function initConnman(next) {
    connman.init(function(err) {
      if (err) return next(err);
      connman.on('state',function(value) {
        debug("Overall state: ",value);
      });
      // log the current services once
      connman.once('networks',function(list) {
        debug("Networks: ",connman.getServicesString(list));
      });
      // log the services on change 
      connman.on('networks',function(list) {
        if(!logNetworksOnChange) return;
        debug("Networks: ",connman.getServicesString(list));
      });
      next();
    });
  },
  function initEthernet(next) {
    connman.initEthernet(function(err,newEthernet,properties) {
      if(err) return debug("[ERROR] init ethernet: ",err);
      debug("ethernet properties: ",properties);
      ethernet = newEthernet;
      ethernet.on('state',function(value) {
        debug("Ethernet state: ",value);
      });
    });
    next();
  },
  function initWiFi(next) {
    connman.initWiFi(function(err,newWiFi,properties) {
      if(err) next(err); 
      wifi = newWiFi;
      debug("wifi connected: ",properties.connected);
      
      wifi.on('state',function(value) {
        debug("WiFi state change: ",value);
        if(value === Connman.WiFi.STATES.FAILURE) {
          debug('WiFi connection failed, become hotspot');
          wifi.openHotspot();
        }
      }); 
      wifi.on('ssid',function(value) {
        debug("WiFi ssid change: ",value);
      });
      
      if(properties.connected) return next(); // already connected? 
      wifi.joinFavorite(function(err) {
        if(err) wifi.openHotspot(null,null,next);
        else next();
      });
    });
  }
],function(err) {
  debug("start seq finished: ",err || '');
  if(err) return; 
});

// listen for the "keypress" event
process.stdin.on('keypress', function (ch, key) {
  //debug('keypress: ', ch, key);
  var keyName = (key)? key.name : ch;
  debug("");
  debug(keyName+" > ");
  switch(keyName) {
    case 'c':
      if(key.ctrl) process.exit(1);
      break;
    case 'f': 
      wifi.joinFavorite();
      break;
    case 'd':
      wifi.disconnect(function(err) {
        if(err) debug("[Error] disconnect error: ",err);
      });
      break;
    case 'o':
      if(key.shift) wifi.openHotspot("myHotspot","123",debug); // invalid passphrase
      else if(key.ctrl) wifi.openHotspot("myhotspot","myPassphrase");
      else wifi.openHotspot();
      break;
    case 'x':
      wifi.closeHotspot();
      break;
    case 's':
			if(key.shift) wifi.scan(true); // switchTether
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
      debug("connman properties: ",connman.getProperties());
      debug("wifi properties: ",wifi.getProperties());
      debug("wifi connection properties: ",wifi.getConnectionProperties());
      debug("ethernet properties: ",ethernet.getProperties());
      debug("ethernet connection properties: ",ethernet.getConnectionProperties());
      debug("current services: ",connman.getServicesString(connman.getCurrentServices()));
      break;
    case 'l':
      logNetworksOnChange = !logNetworksOnChange;
      debug("logNetworksOnChange: ",logNetworksOnChange);
      break;
    case '-':
      wifi.forgetNetwork(function(err) {
        if (err) debug('forgetNetwork err: ',err);
      });
      break;
    case '?':
      debug(getHelpText());
      break;
  }
  if (key === undefined) {
    // join or forget one of the target networks using number keys
    var joinTargetIndex = parseInt(ch);
    if (!isNaN(joinTargetIndex)) { // number key?
      var network = targetNetworks[joinTargetIndex];
      debug('join network '+joinTargetIndex+': ',network);
      wifi.join.apply(wifi,network);
    }
    var forgetTargetIndex = ' !@#$%^&*('.indexOf(ch);
    if (forgetTargetIndex !== -1) {
      var network = targetNetworks[forgetTargetIndex] || '';
      debug('forget network ' + forgetTargetIndex + ': ',network);
      debug(network[0]);
      wifi.forgetNetwork(network[0],function(err) {
        if (err) debug('forgetNetwork err: ',err);
      });
    }
  }
});

/* Retrieve target networks from environment variables. Tip: add them to your ~/.bash_profile
 * Example: 
 * export WIFI_1='myfirstnetwork:thecorrectpassphrase'
 * export WIFI_2='myfirstnetwork:wrongpassphrase'
 * export WIFI_3='anothernetwork:wrongpassword'
 * export WIFI_4='anothernetwork'
 * export WIFI_5='unsecurednetwork'
 * export WIFI_6='wrongnetwork:wrongpassword'
 */
function retrieveEnvVars() {
  var env = process.env;
  for(var key in env) {
    var value = env[key];
    if(key.indexOf('WIFI') === 0) {
      var index = parseInt(key.charAt(5));
      targetNetworks[index] = value.split(':');
    }
  }
}

function getHelpText() {
  var help = '\nHelp: ';
  help += '\n f: Join a favorite network';
  help += '\n d: Disconnect from current network';
  help += '\n -: Forget current network';
  help += '\n o: Open hotspot';
  help += '\n x: Close hotspot';
  help += '\n s: Scan for networks';
  help += '\n shift+s: Scan for networks (switchTethering)';
  help += '\n g: Get networks';
  help += '\n shift+g: Get cached networks';
  help += '\n i: Get connection info';
  help += '\n l: Toggle log networks on change';
  help += '\n ?: Get help';
  
  for(var i=1;i<targetNetworks.length;i++) {
    var targetNetwork = targetNetworks[i];
    help += '\n '+i+': Join: '+targetNetwork;
  }
  for(i=1;i<targetNetworks.length;i++) {
    var targetNetwork = targetNetworks[i];
    help += '\n shift+'+i+': Forget: '+targetNetwork;
  }
  return help;
}