const ConnMan = require('jsdx-connman');
const debug = require('debug')('connman-tests');
const async = require('async');
const Ethernet = require('./Ethernet');
const WiFi = require('./WiFi');
const keypress = require('keypress');

var connMan;
var ethernet;
var wifi;
var wifiNetworks;

keypress(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();

async.series([
  function initConnMan(next) {
    //NOTE: Network.js DBUS needs environment vars below
    //from: http://stackoverflow.com/questions/8556777/dbus-php-unable-to-launch-dbus-daemon-without-display-for-x11  
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/dbus/system_bus_socket';
    process.env.DISPLAY = ':0';
    connMan = new ConnMan();
    debug('initializing connman...');
    connMan.init(function(err) {
      if (err) {
        debug('[ERROR] connman init: ',err);
        return;
      }
      next();
    });
  },
  function initEthernet(next) {
    debug("initEthernet");
    ethernet = new Ethernet(connMan);
    ethernet.init(function(err) {
      if(err) debug("[ERROR] init wifi: ",err);
    });
    next();
  },
  function initWiFi(next) {
    debug("initWiFi");
    wifi = new WiFi(connMan); 
    wifi.init(function(err,properties) {
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
  
  // ToDo: open hotspot on connection issues
  wifi.on('State',function(value) {
    debug("WiFi State change: ",value);
    if(value === WiFi.WIFI_STATES.FAILURE) {
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
      wifi.scan();
      break;
    case 'r':
      wifi.scan(true);
      break;
    case 'g':
      wifi.getNetworks(function(err,list) {
        //debug("found networks: ",err,list);
        if(err) debug("[ERROR] get networks: ",err);
      });
      break;
    case 'h':
      wifi.getNetworksCache(function(err,list) {
        debug("found cached networks: ",err || '',list);
      });
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