Connman simplified
===================

Node.js package that simplifies Connman (Opensource connection manager) usage. <br/>
Enables you to easilly control connections over wifi and ethernet. Get realtime status changes. <br/>
Uses [Connman-api package](https://www.npmjs.com/package/connman-api) internally.<br/>
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
  
    if(!properties.connected) { // not yet connected? 
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
      // get cached available networks (collected earlier)
      wifi.getNetworksCache(function(err,list) {
        console.log("networks from cache: ",list);
      });
      
      setTimeout(function() {
        wifi.closeHotspot(function(err) {
          // get fresh available networks
          wifi.getNetworks(function(err,list) {
            console.log("networks: ",list);
          });
        });
      },5000);
    });
    
  });
});
```

Get a more readable networks list. <br/>
Uses common Connman services format, see: https://01.org/connman/documentation
``` javascript
var connman = require('connman-simplified')();
connman.init(function(err) {
  connman.initWiFi(function(err,wifi,properties) {
    
    wifi.getNetworks(function(err,list) {
      // get more readable list using getServicesString:
      console.log("networks: ",wifi.getServicesString(list));
    });
    
  });
});
```
Bigger interactive example is included.

Debugging
------------
Uses [Debug package](https://www.npmjs.com/package/debug), to see all logs run: 
```
$export DEBUG=*
```

License
------------
Licensed under the MIT License

Author
------------
Peter Uithoven @ Doodle3D