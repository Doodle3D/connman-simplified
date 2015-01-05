const ConnMan = require('jsdx-connman');
const debug = require('debug')('connman-tests');
const async = require('async');
const Ethernet = require('./Ethernet');
const WiFi = require('./WiFi');
const keypress = require('keypress');

var timeoutInitConnman = 1000; //4000;
var connMan;
var ethernet;
var wifi;
var wifiNetworks;

var hotspotSSID = "connmanTest";
var hotspotPassphrase = "test";

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
      debug('connMan init response: ',err);
      if (err) {
        debug('[ERROR] connman init');
        debug(err);
        return;
      }
      debug('[OK] connman init (timeout: ' + timeoutInitConnman +')');
      setTimeout(next, timeoutInitConnman);
    });
  },
  function initEthernet(next) {
    debug("initEthernet");
    ethernet = new Ethernet(connMan);
    ethernet.init(next);
  },
  function initWiFi(next) {
    debug("initWiFi");
    wifi = new WiFi(connMan); 
    wifi.init(hotspotSSID,hotspotPassphrase,next);
  },
  function doJoinFavoriteNetwork(next) {
    debug("doJoinFavoriteNetwork");
    wifi.joinFavorite(function(err) {
      if(err) wifi.openHotspot(null,null,next);
      else next();
    });
  }
],function(err) {
  debug("start seq finished: ",err);
});

// listen for the "keypress" event
process.stdin.on('keypress', function (ch, key) {
  //console.log('got "keypress"', key);
  debug(key.name+":");
  switch(key.name) {
    case 'c':
      if(key.ctrl) process.exit(1);
      //else wifi.join("hss");
      else wifi.join("Vechtclub XL F1.19",'groentegorilla');
      break;
    case 'f': 
      wifi.joinFavorite();
      break;
    case 'd':
      wifi.disconnect();
      break;
    case 'o':
      wifi.openHotspot();
      break;
    case 'x':
      wifi.closeHotspot();
      break;
    case 'g':
      wifi.getNetworks(function(err,list) {
        debug("found networks: ",err,list);
      });
      break;
      
  }
});