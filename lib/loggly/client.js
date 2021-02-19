/*
 * client.js: Core client functions for accessing Loggly
 *
 * (C) 2010 Charlie Robbins
 * MIT LICENSE
 *
 */
//
// Setting constant value of EVENT_SIZE variable
//
let EVENT_SIZE = 1000 * 1000;
let events = require('events'),
    util = require('util'),
    qs = require('querystring'),
    common = require('./common'),
    loggly = require('../loggly'),
    Search = require('./search').Search,
    stringifySafe = require('json-stringify-safe');

function stringify(msg) {
  let payload;

  try { payload = JSON.stringify(msg) }
  catch (ex) { payload = stringifySafe(msg, null, null, noop) }

  return payload;
}
//
// function to truncate message over 1 MB
// 
function truncateLargeMessage(message) {
  let maximumBytesAllowedToLoggly = EVENT_SIZE;
  let bytesLengthOfLogMessage = Buffer.byteLength(message);
  let isMessageTruncated = false;
  if(bytesLengthOfLogMessage > maximumBytesAllowedToLoggly) {
    message = message.slice(0, maximumBytesAllowedToLoggly);
    isMessageTruncated = true;
  }
  return {
    message: message,
    isMessageTruncated: isMessageTruncated
  };
}

//
// function createClient (options)
//   Creates a new instance of a Loggly client.
//
exports.createClient = function (options) {
  return new Loggly(options);
};

//
// ### function Loggly (options)
// #### @options {Object} Options for this Loggly client
// ####   @subdomain
// ####   @token
// ####   @json
// ####   @auth
// ####   @tags
// Constructor for the Loggly object
//
let Loggly = exports.Loggly = function (options) {
  if (!options || !options.subdomain || !options.token) {
    throw new Error('options.subdomain and options.token are required.');
  }

  events.EventEmitter.call(this);

  this.subdomain              = options.subdomain;
  this.token                  = options.token;
  this.host                   = options.host || 'logs-01.loggly.com';
  this.json                   = options.json || null;
  this.auth                   = options.auth || null;
  this.proxy                  = options.proxy || null;
  this.userAgent              = 'node-loggly ' + loggly.version;
  this.useTagHeader           = 'useTagHeader' in options ? options.useTagHeader : true;
  this.isBulk                 = options.isBulk || false;
  this.bufferOptions          = options.bufferOptions || {size: 500, retriesInMilliSeconds: 30 * 1000};
  this.networkErrorsOnConsole = options.networkErrorsOnConsole || false;
  this.appName                = options.appName || false;
  //
  // Set the tags on this instance.
  //
  this.tags = options.tags
    ? this.tagFilter(options.tags)
    : null;

  let url   = 'https://' + this.host,
      api   = options.api  || 'apiv2';

  this.urls = {
    default: url,
    log:     [url, 'inputs', this.token].join('/'),
    bulk:    [url, 'bulk', this.token].join('/'),
    api:     'https://' + [this.subdomain, 'loggly', 'com'].join('.') + '/' + api
  };
};

//
// Inherit from events.EventEmitter
//
util.inherits(Loggly, events.EventEmitter);

//
// ### function log (msg, tags, callback)
// #### @msg {string|Object} Data to log
// #### @tags {Array} **Optional** Tags to send with this msg
// #### @callback {function} Continuation to respond to when complete.
// Logs the message to the token associated with this instance. If
// the message is an Object we will attempt to serialize it. If any
// `tags` are supplied they will be passed via the `X-LOGGLY-TAG` header.
//  - http://www.loggly.com/docs/api-sending-data/
//
Loggly.prototype.log = function (msg, tags, callback) {
  // typeof msg is string when we are using node-loggly-bulk to send logs.
  // If we are sending logs using winston-loggly-bulk, msg is object.
  // Check if 'msg' is an object, if yes then stringify it to truncate it over 1MB.
  let truncatedMessageObject = null;
  if(typeof(msg) === 'object'){
    let stringifiedMessage = JSON.stringify(msg)
    truncatedMessageObject = truncateLargeMessage(stringifiedMessage);
    msg = truncatedMessageObject.isMessageTruncated ? truncatedMessageObject.message : msg;
  }else if (typeof(msg) === 'string') {
    truncatedMessageObject = truncateLargeMessage(msg);
    msg = truncatedMessageObject.isMessageTruncated ? truncatedMessageObject.message : msg;
  }
  if (!callback && typeof tags === 'function') {
    callback = tags;
    tags = null;
  }

  let self = this,
      logOptions;

  //
  // Remark: Have some extra logic for detecting if we want to make a bulk
  // request to loggly
  //
  function serialize(msg) {
    if (msg instanceof Object) {
      return self.json ? stringify(msg) : common.serialize(msg);
    }
    else {
      return self.json ? stringify({ message: msg }) : msg;
    }
  }

  msg = this.isBulk && Array.isArray(msg) ? msg.map(serialize) : serialize(msg);

  logOptions = {
    uri:     this.isBulk ? this.urls.bulk : this.urls.log,
    method:  'POST',
    body:    msg,
    proxy:   this.proxy,
    isBulk: this.isBulk,
    bufferOptions: this.bufferOptions,
    networkErrorsOnConsole: this.networkErrorsOnConsole,
    headers: {
      host:             this.host,
      accept:           '*/*',
      'user-agent':     this.userAgent,
      'content-type':   this.json ? 'application/json' : 'text/plain'
    }
  };

  //
  // Remark: if tags are passed in run the filter on them and concat
  // with any tags that were passed or just use default tags if they exist
  //
  tags = tags
    ? (this.tags ? this.tags.concat(this.tagFilter(tags)) : this.tagFilter(tags))
    : this.tags;

  //
  // Optionally send `X-LOGGLY-TAG` if we have them.
  // Set the 'X-LOGGLY-TAG' only when we have actually some tag value.
  // The library receives "400 Bad Request" in response when the
  // value of 'X-LOGGLY-TAG' is empty string in request header.
  //
  if (tags && tags.length) {
    // Decide whether to add tags as http headers or add them to the URI.
    if (this.useTagHeader) {
      logOptions.headers['X-LOGGLY-TAG'] = tags.join(',');
    }
    else {
      logOptions.uri += '/tag/' + tags.join(',') + '/';
    }
  }
  
  if (this.appName) {
    logOptions.headers['appName'] = this.appName;
  }

  common.loggly(logOptions, callback, function (res, body) {
    try {
      if(body && res.statusCode.toString() === '200'){
        let result = JSON.parse(body);
        self.emit('log', result);
        if (callback) {
          callback(null, result);
        }
      }
      else
       console.log('Error Code- ' + res.statusCode + ' "' + res.statusMessage + '"');
    }
    catch (ex) {
      if (callback) {
        callback(new Error('Unspecified error from Loggly: ' + ex));
      }
    }
  });

  return this;
};

//
// ### function tag (tags)
// #### @tags {Array} Tags to use for `X-LOGGLY-TAG`
// Sets the tags on this instance
//
Loggly.prototype.tagFilter = function (tags) {
  let isSolid = /^[\w\d][\w\d-_.]+/;

  tags = !Array.isArray(tags)
    ? [tags]
    : tags;

  //
  // TODO: Filter against valid tag names with some Regex
  // http://www.loggly.com/docs/tags/
  // Remark: Docs make me think we dont need this but whatevs
  //
  return tags.filter(function (tag) {
    //
    // Remark: length may need to use Buffer.byteLength?
    //
    return tag && isSolid.test(tag) && tag.length <= 64;
  });
};

//
// ### function customer (callback)
// ### @callback {function} Continuation to respond to.
// Retrieves the customer information from the Loggly API:
//   - http://www.loggly.com/docs/api-account-info/
//
Loggly.prototype.customer = function (callback) {
  common.loggly({
    uri: this.logglyUrl('customer'),
    auth: this.auth
  }, callback, function (res, body) {
    let customer;
    try { customer = JSON.parse(body) }
    catch (ex) { return callback(ex) }
    callback(null, customer);
  });
};

//
// function search (query, callback)
//   Returns a new search object which can be chained
//   with options or called directly if @callback is passed
//   initially.
//
// Sample Usage:
//
//   client.search('404', function () { /* ... */ })
//         .on('rsid', function (rsid) { /* ... */ })
//
//   client.search({ query: '404', rows: 100 })
//         .on('rsid', function (rsid) { /* ... */ })
//         .run(function () { /* ... */ });
//
Loggly.prototype.search = function (query, callback) {
  let options = typeof query === 'string'
    ? { query: query }
    : query;

  options.callback = callback;
  return new Search(options, this);
};

//
// function logglyUrl ([path, to, resource])
//   Helper method that concats the string params into a url
//   to request against a loggly serverUrl.
//
Loggly.prototype.logglyUrl = function (/* path, to, resource */) {
  let args = Array.prototype.slice.call(arguments);
  return [this.urls.api].concat(args).join('/');
};

//
// Simple noop function for reusability
//
function noop() {}