'use strict';
var tough = require('tough-cookie');
var Store = tough.Store;
var permuteDomain = tough.permuteDomain;
var permutePath = tough.permutePath;
var util = require('util');
var fs = require('fs');
var request = require('request');
var google = require('googleapis').google;

function FileCookieStore(auth, fileId) {
    Store.call(this);
    this.idx = {}; // idx is memory cache
    this.fileId = fileId;
    this.auth = auth;
    var self = this;
    loadFromFile(this.fileId, this.auth, function(dataJson) {
        if (dataJson)
            self.idx = dataJson;
    })
}

util.inherits(FileCookieStore, Store);
exports.FileCookieStore = FileCookieStore;
FileCookieStore.prototype.idx = null;
FileCookieStore.prototype.synchronous = true;

// force a default depth:
FileCookieStore.prototype.inspect = function() {
    return "{ idx: " + util.inspect(this.idx, false, 2) + ' }';
};

FileCookieStore.prototype.findCookie = function(domain, path, key, cb) {
    if (!this.idx[domain]) {
        return cb(null, undefined);
    }
    if (!this.idx[domain][path]) {
        return cb(null, undefined);
    }
    return cb(null, this.idx[domain][path][key] || null);
};

FileCookieStore.prototype.findCookies = function(domain, path, cb) {
    var results = [];
    if (!domain) {
        return cb(null, []);
    }

    var pathMatcher;
    if (!path) {
        // null or '/' means "all paths"
        pathMatcher = function matchAll(domainIndex) {
            for (var curPath in domainIndex) {
                var pathIndex = domainIndex[curPath];
                for (var key in pathIndex) {
                    results.push(pathIndex[key]);
                }
            }
        };

    } else if (path === '/') {
        pathMatcher = function matchSlash(domainIndex) {
            var pathIndex = domainIndex['/'];
            if (!pathIndex) {
                return;
            }
            for (var key in pathIndex) {
                results.push(pathIndex[key]);
            }
        };

    } else {
        var paths = permutePath(path) || [path];
        pathMatcher = function matchRFC(domainIndex) {
            paths.forEach(function(curPath) {
                var pathIndex = domainIndex[curPath];
                if (!pathIndex) {
                    return;
                }
                for (var key in pathIndex) {
                    results.push(pathIndex[key]);
                }
            });
        };
    }

    var domains = permuteDomain(domain) || [domain];
    var idx = this.idx;
    domains.forEach(function(curDomain) {
        var domainIndex = idx[curDomain];
        if (!domainIndex) {
            return;
        }
        pathMatcher(domainIndex);
    });

    cb(null, results);
};

FileCookieStore.prototype.putCookie = function(cookie, cb) {
    if (!this.idx[cookie.domain]) {
        this.idx[cookie.domain] = {};
    }
    if (!this.idx[cookie.domain][cookie.path]) {
        this.idx[cookie.domain][cookie.path] = {};
    }
    this.idx[cookie.domain][cookie.path][cookie.key] = cookie;
    saveToFile(this.fileId, this.auth, this.idx, function() {
        cb(null);
    });
};

FileCookieStore.prototype.updateCookie = function updateCookie(oldCookie, newCookie, cb) {
    // updateCookie() may avoid updating cookies that are identical.  For example,
    // lastAccessed may not be important to some stores and an equality
    // comparison could exclude that field.
    this.putCookie(newCookie, cb);
};

FileCookieStore.prototype.removeCookie = function removeCookie(domain, path, key, cb) {
    if (this.idx[domain] && this.idx[domain][path] && this.idx[domain][path][key]) {
        delete this.idx[domain][path][key];
    }
    saveToFile(this.fileId, this.auth, this.idx, function() {
        cb(null);
    });
};

FileCookieStore.prototype.removeCookies = function removeCookies(domain, path, cb) {
    if (this.idx[domain]) {
        if (path) {
            delete this.idx[domain][path];
        } else {
            delete this.idx[domain];
        }
    }
    saveToFile(this.fileId, this.auth, this.idx, function() {
        return cb(null);
    });
};

FileCookieStore.prototype.checkExpired = function(domain, path, key) {
    var domains = []
    if (domain) domains = [domain]
    else domains = Object.keys(this.idx)
    var isExpired = false
    var that = this
    domains.forEach(function(d) {
        var paths = []
        if (path) paths = [path]
        else paths = Object.keys(that.idx[d])
        paths.forEach(function(p) {
            var keys = []
            if (key) keys = [key]
            else keys = Object.keys(that.idx[d][p])
            keys.forEach(function(k) {
                var expiresDate = that.idx[d][p][k].expires
                var now = new Date()
                if (isFinite(expiresDate)) {
                    if (expiresDate - now < 30 * 60)
                        isExpired = true
                }
            })
        })
    })
    return isExpired
}

FileCookieStore.prototype.isExpired = function() {
    return this.checkExpired(null, null, null)
}

FileCookieStore.prototype.isEmpty = function (){
    return isEmptyObject(this.idx);
}

FileCookieStore.prototype.getAllCookies = function(cb) {
  var cookies = [];
  var idx = this.idx;
 
  var domains = Object.keys(idx);
  domains.forEach(function(domain) {
    var paths = Object.keys(idx[domain]);
    paths.forEach(function(path) {
      var keys = Object.keys(idx[domain][path]);
      keys.forEach(function(key) {
        if (key !== null) {
          cookies.push(idx[domain][path][key]);
        }
      });
    });
  });
 
  // Sort by creationIndex so deserializing retains the creation order.
  // When implementing your own store, this SHOULD retain the order too
  cookies.sort(function(a,b) {
    return (a.creationIndex||0) - (b.creationIndex||0);
  });
 
  cb(null, cookies);
};

// Avoid parallel writes to the same file
var _writing_ = {};
function writeFile(fileId, auth, data, done) {
    var dataJson = JSON.stringify(data);
    var wo = { done: done, next: [] };
    _writing_[fileId] = wo;
    var drive = google.drive({version:'v2', auth:auth});
    drive.files.update({
        fileId: fileId,
        uploadType: 'media',
        media: {
            mimeType: 'application/json',
            body: dataJson
        }
    }, function (err, ret) {
        // If we have new pending writes, execute them now
        if ( wo.next.length ) {
            writeFile(fileId, auth, wo.data, wo.next);
        }
        else {
            delete _writing_[fileId];
        }
        if (err) throw err;
        wo.done.forEach(function(cb) {
            cb();
        });
    });
}

function saveToFile(fileId, auth, data, cb) {
    var wo = _writing_[fileId];
    // If not writing to this file, start writing right now
    if ( !wo ) {
        writeFile(fileId, auth, data, [cb]);
    }
    // If writing in process, add to pending
    else {
        wo.data = data;
        wo.next.push(cb);
    }
}

function loadFromFile(fileId, auth, cb) {
    var drive = google.drive({version:'v2', auth:auth});
    drive.files.get({fileId: fileId}, function (err, ret) {
        request({
            url: ret.data.downloadUrl,
            method: 'GET',
            headers: {
                'Authorization': 'Bearer '+auth.credentials.access_token
            }
        }, function(err, res, data){
            if (data) {
                try {
                    var dataJson = JSON.parse(data);
                } catch (e) {
                    throw new Error('Could not parse cookie file ' + fileId + '. Please ensure it is not corrupted.');
                }
            } else {
                var dataJson = null;
            }
            for (var domainName in dataJson) {
                for (var pathName in dataJson[domainName]) {
                    for (var cookieName in dataJson[domainName][pathName]) {
                        dataJson[domainName][pathName][cookieName] = tough.fromJSON(JSON.stringify(dataJson[domainName][pathName][cookieName]));
                    }
                }
            }
            cb(dataJson);
        });
    });
}

function isEmptyObject(obj) {
    for (var key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            return false;
        }
    }
    return true;
}
