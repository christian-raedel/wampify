var _ = require('lodash')
    , util = require('util')
    , fs = require('fs')
    , path = require('path')
    , q = require('q')
    , WebSocketServer = require('ws').Server
    , WebSocket = require('ws')
    , shortid = require('shortid')
    , CConf = require('node-cconf')
    , CLogger = require('node-clogger');

/**
 * Wampify - A [node.js]{@link http://nodejs.org} [WAMP]{@link http://wamp.ws}-style
 * RPC & Pub/Sub implementation using WebSockets.
 * @constructor
 * @param {object} opts (optional) - See example for valid configuration options.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Create a new instance of {@link Wampify} WebSocket-Server. Valid options
 * are: a 'name', a 'port' number or a (http-) 'server' instance and an optional instance of 
 * [CLogger]{@link http://github.com/christian-raedel/node-clogger}. If provided, the
 * option 'plugins' points to a directory from which RPC-function are loaded from.
 * @example
 * var Wampify = require('wampify');
 * var server = new Wampify({
 *      name: 'wampify',
 *      port: 3000,                             // port or server is mandatory!
 *      server: require('http').createServer(), // 
 *      logger: clogger,
 *      plugins: __dirname + '/rpc-function-modules'
 * });
 */ 
function Wampify(opts) {
    opts = opts || {};
    opts.name = opts.name || 'wampify';

    var logger = opts.logger;
    if (logger) {
        delete opts.logger;
    } else {
        logger = new CLogger({name: opts.name});
    }
    logger.extend(this);

    if (!opts.server && !opts.port) {
        throw new Error('Provide at least "server" or "port" option!');
    }
    WebSocketServer.apply(this, [opts]);

    var self = this;
    this.on('connection', function(socket) {
        self.addSocket(socket);
    });

    this.on('error', function(error) {
        self.error('Wampify error:', err.message);
    });

    var config = new CConf(opts.name).load(opts);

    this.config = config;
    this.sockets = [];
    this.rprocs = {};
    this.channels = {};
    this.loadPlugins();
}

util.inherits(Wampify, WebSocketServer);

/**
 * @method Wampify.addSocket
 * @private
 * @param {object} socket - An instance of [WebSocket]{@link https://github.com/einaros/ws/blob/master/doc/ws.md}.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Attach an identifier and used events to a socket and store a reference for later use.
 */
Wampify.prototype.addSocket = function(socket) {
    if (socket instanceof WebSocket) {
        var id = shortid.generate();
        socket.id = id;

        if (_.indexOf(this.sockets, id) === -1) {
            var self = this;

            socket.on('message', function(data) {
                self.parse(socket, data);
            });

            socket.on('error', function(err) {
                self.error('Socket error: %s', err.message);
            });

            socket.on('close', function(code, reason) {
                self.info('Socket with id [%s] closed: %s %s', id, code, reason);
                self.removeSocket(id);
            });

            this.info('Socket with id [%s] opened...', id);
            this.sockets.push(id);
        } else {
            this.warn('Cannot add socket, because it already exists!');
        }
    } else {
        throw new TypeError('Wampify.addSocket accepts only a socket object as argument!');
    }

    return this;
};

/**
 * @method Wampify.removeSocket
 * @private
 * @param {string} id - An id to identify the socket to be removed.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Remove an unused socket when it was closed.
 */
Wampify.prototype.removeSocket = function(id) {
    if (_.isString(id)) {
        this.sockets = this.sockets.filter(function(value) {
            return value !== id;
        });
    } else {
        throw new TypeError('Wampify.removeSocket accepts only a string as argument!');
    }

    return this;
};

/**
 * @method Wampify.parse
 * @private
 * @param {object} socket - An instance of [WebSocket]{@link https://github.com/einaros/ws/blob/master/doc/ws.md}.
 * @param {string} data - A message, received by the WebSocket.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Parse a socket message (i.e. a RPC or Pub/Sub call) an delegate to appropriate functionality.
 */
Wampify.prototype.parse = function(socket, data) {
    if ((socket instanceof WebSocket) && data) {
        var message = null;
        try {
            message = JSON.parse(data);
            this.debug('Incoming message [%s]...', message);
        } catch(err) {
            this.error('Unable to parse message! Reason: %s', err.message);
        }

        if (_.isArray(message)) {
            var self = this
                , type = message.shift()
                , uri = message.shift()
                , id = message.shift()
                , opts = message.shift()
                , args = message;

            if (_.isString(type) && _.isString(uri) && (_.isNumber(id) || _.isString(id)) &&
                    _.isPlainObject(opts) && _.isArray(args)) {
                switch (type) {
                    case 'RPC':
                        q.fcall(function() {
                            message = self.rprocs[uri].apply(self, args);
                            if (_.isArray(message)) {
                                message = [type, uri, id, opts].concat(message);
                            } else if (_.isPlainObject(message)) {
                                message = [type, uri, id, opts, message];
                            } else {
                                throw new TypeError('RPCs must return a plain object or an argument array!');
                            }

                            return message;
                        }).then(function(message) {
                            message = JSON.stringify(message);
                            q.nfapply(socket.send.bind(socket), [message]).then(function() {
                                self.debug('Successfully respond to RPC [%s] with message [%s]...', uri, message);
                            });
                        }).catch(function(err) {
                            self.error('Unable to call RPC [%s]! Reason: %s', uri, err.message);
                        });
                        break;
                    case 'SUB':
                        self.subscribe(socket, uri).then(function(subscribed) {
                            if (self.channels[uri].opts.ack && opts.ack) {
                                message = JSON.stringify(['ACK', uri, id, {}, subscribed]);
                                q.nfapply(socket.send.bind(socket), [message]).then(function() {
                                    self.debug('Successfully respond to subscription request for channel [%s] with message [%s]...', uri, message);
                                });
                            }
                        }).catch(function(err) {
                            self.error('Unable to subscribe to channel [%s]! Reason: %s', uri, err.message);
                        });
                        break;
                    case 'UNSUB':
                        self.unsubscribe(socket, uri).then(function(unsubscribed) {
                            if (self.channels[uri].opts.ack && opts.ack) {
                                message = JSON.stringify(['ACK', uri, id, {}, unsubscribed]);
                                q.nfapply(socket.send.bind(socket), [message]).then(function() {
                                    self.debug('Successfully respond to unsubscription request for channel [%s] with message [%s]...', uri, message);
                                });
                            }
                        }).catch(function(err) {
                            self.error('Unable to unsubscribe from channel [%s]! Reason: %s', uri, err.message);
                        });
                        break;
                    case 'PUB':
                        message = [type, uri, id, {}].concat(message);
                        self.debug('Publishing message [%j] to channel [%s]...', message, uri);
                        self.publish(uri, message).then(function(published) {
                            if (self.channels[uri].opts.ack && opts.ack) {
                                message = JSON.stringify(['ACK', uri, id, {}, published]);
                                self.debug('Sending acknowledge message [%s] to socket [%s]...', message, socket.id);
                                q.nfapply(socket.send.bind(socket), [message]).then(function() {
                                    self.debug('Successfully respond to publish request for channel [%s] with message [%s]...', uri, message);
                                });
                            }
                        }).catch(function(err) {
                            self.error('Unable to publish to channel [%s]! Reason: %s', uri, err.message);
                        });
                        break;
                    default:
                        this.warn('Not implemented yet! [%s]', type);
                }
            } else {
                this.error('Invalid message received: [type: %j][uri: %j][id: %j][opts: %j][args: %j]', type, uri, id, opts, args);
            }
        } else {
            this.error('Invalid message received: %j', message);
        }
    } else {
        throw new TypeError('Wampify.parse accepts only a socket object an a data object as arguments!');
    }

    return this;
};

/**
 * @method Wampify.loadPlugins
 * @param {string} dir (optional) - A directory with RPC-function-modules to be loaded.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Load each Javascript-file from a directory as node-module an register
 * its functions for RPC-calls.
 */
Wampify.prototype.loadPlugins = function(dir) {
    dir = dir || this.config.getValue('plugins');

    if (_.isString(dir)) {
        if (fs.statSync(dir).isDirectory()) {
            _.forEach(fs.readdirSync(dir), function(filename) {
                var file = path.resolve(dir, filename);
                if (fs.statSync(file).isFile() && filename.match(/.*\.js$/)) {
                    this.rprocs = _.merge(this.rprocs, require(file));
                    this.debug('Loaded plugin file: %s', file);
                } else {
                    this.warn('Cannot load RPC plugin [%s]!', file);
                }
            }, this);

            this.info('Loaded [%d] plugins...', _.keys(this.rprocs).length);
        } else {
            this.error('Configured RPC plugin directory [%s] is not a directory!', dir);
        }
    }

    return this;
};

/**
 * @method Wampify.registerRPC
 * @param {string} uri - The identifying path to the function.
 * @param {function} fn - The function itself.
 * @return [object} this - An instance of {@link Wampify}.
 * @description Register a function to be callable remotely. The function can have variable
 * arguments length, which are sent with the WebSocket-message. The first four message-fields
 * are reserved by 'type', 'uri', 'id' and 'opts' (see example).
 * @example
 * // on server-side
 * var _ = require('lodash');
 * var Wampify = require('wampify');
 * var server = new Wampify({port: 3000}).registerRPC('com.domain.my-functions.sum', function() {
 *      var args = _.toArray(arguments);
 *      var sum = _.reduce(args, function(a, b) {
 *          return a + b;
 *      });
 *      return [sum];
 *  });
 *
 * // on client-side
 * var WebSocket = require('ws');
 * var ws = new WebSocket('ws://localhost:3000');
 * ws.on('open', function() {
 *      ws.send(JSON.stringify(['RPC', 'com.domain.my-functions.sum', 123, {}, 1, 2, 3, 4, 5, 6, 7]));
 * });
 * ws.on('message', function(data) {
 *      var message = JSON.parse(data);
 *      console.log('sum = %d', message[4]);  // 28
 * });
 */
Wampify.prototype.registerRPC = function(uri, fn) {
    if (_.isString(uri) && _.isFunction(fn)) {
        var rprocs = this.rprocs;
        if (_.isFunction(rprocs[uri])) {
            throw new Error('RPC with uri [%s] is already registered!', uri);
        } else {
            rprocs[uri] = fn;
            this.info('Remote procedure for uri [%s] registered...', uri);
        }
    } else {
        throw new TypeError('Wampify.registerRPC accepts only a string and a function as arguments!');
    }

    return this;
};

/**
 * @method Wampify.unregisterRPC
 * @param {string} uri - The identifying path to the function.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Delete a registered function by its uri.
 */
Wampify.prototype.unregisterRPC = function(uri) {
    if (_.isString(uri)) {
        var rprocs = this.rprocs;
        if (_.isFunction(rprocs[uri])) {
            delete rprocs[uri];
            this.info('Remote procedure for uri [%s] deleted...', uri);
        } else {
            throw new Error('Cannot unregister RPC with uri [%s], because this function is not registered!');
        }
    } else {
        throw new TypeError('Wampify.unregisterRPC accepts only a string as argument!');
    }

    return this;
};

/**
 * @method Wampify.addChannel
 * @param {string} uri - The identifying path to the channel.
 * @param {object} opts (optional) - Options to configure the channel.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Create a new channel for publish/subscribe. A valid option
 * is 'ack' (boolean). If set, every published message is acknowledged by the server.
 */
Wampify.prototype.addChannel = function(uri, opts) {
    if (_.isString(uri)) {
        var channels = this.channels;
        if (!channels[uri]) {
            channels[uri] = {
                sockets: [],
                opts: opts || {}
            };
            this.info('Publish/subscribe channel for uri [%s] registered...', uri);
        } else {
            this.warn('A channel named [%s] already exists!', uri);
        }
    } else {
        throw new TypeError('Wampify.addChannel accepts only a string as argument!');
    }

    return this;
};

/**
 * @method Wampify.removeChannel
 * @param {string} uri - The identifying path to the channel.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Delete a channel from the server.
 */
Wampify.prototype.removeChannel = function(uri) {
    if (_.isString(uri)) {
        var channels = this.channels;
        if (channels[uri]) {
            delete channels[uri];
            this.info('Publish/subscribe channel for uri [%s] deleted...', uri);
        } else {
            this.warn('A channel named [%s] does not exist!', uri);
        }
    } else {
        throw new TypeError('Wampify.removeChannel accepts only a string as argument!');
    }

    return this;
};

/**
 * @method Wampify.subscribe
 * @private
 * @param {object} socket - An instance of [WebSocket]{@link https://github.com/einaros/ws/blob/master/doc/ws.md},
 * representing the client-connection.
 * @param {string} uri - The identifying path to the channel.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Add a client-socket to the broadcast list of the channel.
 */
Wampify.prototype.subscribe = function(socket, uri) {
    var defer = q.defer();

    if ((socket instanceof WebSocket) && _.isString(uri)) {
        var channel = this.channels[uri];
        if (_.isPlainObject(channel)) {
            this.info('Socket [%s] subscribed to channel [%s]...', socket.id, uri);
            defer.resolve(channel.sockets.push(socket.id) > -1);
        } else {
            this.warn('Cannot subscribe to non-existent channel [%s]!', uri);
            defer.resolve(false);
        }
    } else {
        defer.reject(new TypeError('Wampify.subscribe accepts only a socket and a string as arguments!'));
    }

    return defer.promise;
};

/**
 * @method Wampify.unsubscribe
 * @private
 * @param {object} socket - An instance of [WebSocket]{@link https://github.com/einaros/ws/blob/master/doc/ws.md}.
 * @param {string} uri - The identifying path to the channel.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Remove a client-socket from the broadcast list of the channel.
 */
Wampify.prototype.unsubscribe = function(socket, uri) {
    var defer = q.defer();

    if ((socket instanceof WebSocket) && _.isString(uri)) {
        var channel = this.channels[uri];
        if (_.isPlainObject(channel)) {
            channel.sockets = channel.sockets.filter(function(id) {
                return id !== socket.id;
            });

            this.info('Socket [%s] cancelled subscription to channel [%s]...', socket.id, uri);
            defer.resolve(_.indexOf(channel.sockets, socket.id) === -1);
        } else {
            this.warn('Cannot unsubscribe from non-existing channel [%s]!', uri);
            defer.resolve(false);
        }
    } else {
        defer.reject(new TypeError('Wampify.unsubscribe accepts only a socket and a string as arguments!'));
    }

    return defer.promise;
};

/**
 * @method Wampify.publish
 * @private
 * @param {string} uri - The identifying path to the channel.
 * @param {array} message - The message to publish over the wire.
 * @return {object} this - An instance of {@link Wampify}.
 * @description Send a message to all client-sockets subscribed to a channel.
 */
Wampify.prototype.publish = function(uri, message) {
    var defer = q.defer();

    if (_.isString(uri) && _.isArray(message)) {
        var channel = this.channels[uri];
        if (_.isPlainObject(channel)) {
            message = JSON.stringify(message);

            var self = this
                , promises = [];
            _.forEach(this.clients, function(socket) {
                if (_.indexOf(channel.sockets, socket.id) > -1) {
                    var send = q.nfapply(socket.send.bind(socket), [message]);
                    promises.push(send);
                    self.debug('Sending message [%s] to socket [%s]...', message, socket.id);
                } else {
                    self.debug('Socket [%s] is not in channel...', socket.id);
                }
            });

            q.allSettled(promises).spread(function(published) {
                var fulfilled = published.state === 'fulfilled';
                self.debug('Published promises: %j', fulfilled);
                defer.resolve(fulfilled);
            }, function(err) {
                self.debug('Publishing rejected: %j', err);
                defer.reject(err);
            }).done();
        } else {
            this.warn('Cannot publish to non-existent channel [%s]!', uri);
        }
    } else {
        throw new TypeError('Wampify.publish accepts only a string and an array as arguments!');
    }

    return defer.promise;
};

module.exports = Wampify;
