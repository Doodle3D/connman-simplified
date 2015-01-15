Connman-simplified
===================

Node.js package that simplifies Connman (Opensource connection manager) usage. <br/>
Enables you to easilly control connections over wifi and ethernet. Get realtime status changes. 
Uses Connman-api internally.<br/>
Connman: http://www.connman.net/

- Abstracts Connman API making your code shorter and simpler.
- Includes network cache system (for when scanning is impossible in hotspot mode).
- Uses regular Node.js naming conventions. 

Examples
------------
Try to connect to favorite wifi network, if fails become hotspot. Log the wifi state changes.
``` javascript
var connman = require('connman-simplified')();
connman.init(function(err) {
  connman.initWiFi(function(err,wifi,properties) {
  
    if(!properties.connected) { // already connected?
      wifi.joinFavorite(function(err) {
        if(err) wifi.openHotspot();
      });
    }
    wifi.on('state',function(value) {
      console.log("WiFi state change: ",value);
    });
    
  });
});
```
Join specific network, disconnect after 5 seconds.
``` javascript
var connman = require('connman-simplified')();
connman.init(function(err) {
  connman.initWiFi(function(err,wifi,properties) {
  
    wifi.join("myhomenetwork",'myPassphrase');
    setTimeout(function() {
      wifi.disconnect();
    },5000);
    
  });
});
```
Open a hotspot, get cached available networks, close after 5 seconds, get fresh available networks.
Retrieving networks from cache is usefull because usually hardware can't scan while being hotspot.
``` javascript
var connman = require('connman-simplified')();
connman.init(function(err) {
  connman.initWiFi(function(err,wifi,properties) {
    
    wifi.openHotspot("myhotspot","aPassphrase",function(err) {
      // get cached available networks
      wifi.getNetworksCache(function(err,list) {
        console.log("networks from cache: ",list);
      });
      setTimeout(function() {
        wifi.closeHotspot(function(err) {
          // get fresh available networks
          wifi.getNetworks(function(err,list) {
            console.log("networks: ",list);
            // better readable log using getServicesString:
            console.log("networks: ",wifi.getServicesString(list));
          });
        });
      },5000);
    });
    
  });
});
```
Bigger interactive example is included.

Debugging
------------
Uses [Debug module](https://www.npmjs.com/package/debug), to see all logs run: 
```
$export DEBUG=*
```

License
------------
Licensed under the MIT License

Author
------------
Peter Uithoven @ Doodle3D