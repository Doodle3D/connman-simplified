var debug           = require('debug')('connman-simplified:configfiles');
var fs              = require('fs');

module.exports.path = '/var/lib/connman/';
module.exports.create = function (ssid, passphrase, callback) {
  debug("create: ",ssid,passphrase);
  var ssidHex = stringToHex(ssid);
  var path = module.exports.path+'network-' + ssidHex + '.config';
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
};
module.exports.remove = function (ssid, callback) {
  var ssidHex = stringToHex(ssid);
  var pathConfig = module.exports.path+'network-' + ssidHex + '.config';
  fs.exists(pathConfig, function(exists) {
    if (exists) {
      fs.unlink(pathConfig, function(err) {
        if (err) {
          debug('FS UNLINK Error: ' + err);
          if (callback) callback(err);
          return;
        }
        // config settings folder automatically removed by connman
        debug('removed favorite network: ' + ssid);
        if (callback) callback(null, {message: 'removed favorite network ' + ssid});
      });
    } else {
      debug('removed favorite open network (set favorite to false): ' +ssid);
      if (callback) callback(null, {message: 'remove favorite open network (set favorite to false) ' + ssid});
    }
  });
};
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
}