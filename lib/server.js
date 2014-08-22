var _ = require('lodash')
    , util = require('util')
    , fs = require('fs')
    , path = require('path')
    , q = require('q')
    , WebSocketServer = require('ws').Server
    , WebSocket = require('ws')
    , shortid = require('shortid')
    , CConf = require('node-cconf').CConf
    , clogger = require('node-clogger');

function Server(opts) {
    opts = opts || {};
    opts.name = opts.name || 'websocket-server';

    var logger = opts.logger;
    if (logger) {
        delete opts.logger;
    } else {
        logger = new clogger.CLogger(opts.name);
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
        self.error('Server error:', err.message);
    });

    var config = new CConf(opts.name).load(opts);

    this.config = config;
    this.sockets = [];
    this.rprocs = {};
    this.channels = {};
    this.loadPlugins();
}

util.inherits(Server, WebSocketServer);

Server.prototype.addSocket = function(socket) {
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
        throw new TypeError('Server.addSocket accepts only a socket object as argument!');
    }

    return this;
};

Server.prototype.removeSocket = function(id) {
    if (_.isString(id)) {
        this.sockets = this.sockets.filter(function(value) {
            return value !== id;
        });
    } else {
        throw new TypeError('Server.removeSocket accepts only a string as argument!');
    }

    return this;
};

Server.prototype.parse = function(socket, data) {
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
                            socket.send(message, function(err) {
                                if (err) {
                                    throw err;
                                } else {
                                    self.debug('Successfully respond to RPC [%s] with message [%s]...', uri, message);
                                }
                            });
                        }).catch(function(err) {
                            self.error('Unable to call RPC [%s]! Reason: %s', uri, err.message);
                        });
                        break;
                    case 'SUB':
                        q.fcall(function() {
                            var subscribed = self.subscribe(socket, uri) ? true : false;
                            if (self.channels[uri].opts.ack && opts.ack) {
                                message = JSON.stringify(['ACK', uri, id, {}, subscribed]);
                                socket.send(message, function(err) {
                                    if (err) {
                                        throw err;
                                    } else {
                                        self.debug('Successfully respond to subscription request for channel [%s] with message [%s]...', uri, message);
                                    }
                                });
                            }
                        }).catch(function(err) {
                            self.error('Unable to subscribe to channel [%s]! Reason: %s', uri, err.message);
                        });
                        break;
                    case 'UNSUB':
                        q.fcall(function() {
                            var unsubscribed = self.unsubscribe(socket, uri) ? true : false;
                            if (self.channels[uri].opts.ack && opts.ack) {
                                message = JSON.stringify(['ACK', uri, id, {}, unsubscribed]);
                                socket.send(message, function(err) {
                                    if (err) {
                                        throw err;
                                    } else {
                                        self.debug('Successfully respond to unsubscription request for channel [%s] with message [%s]...', uri, message);
                                    }
                                });
                            }
                        }).catch(function(err) {
                            self.error('Unable to unsubscribe from channel [%s]! Reason: %s', uri, err.message);
                        });
                        break;
                    case 'PUB':
                        q.fcall(function() {
                            message = [type, uri, id, {}].concat(message);
                            self.debug('Publishing message [%j] to channel [%s]...', message, uri);
                            self.publish(uri, message).then(function(published) {
                                if (self.channels[uri].opts.ack && opts.ack) {
                                    message = JSON.stringify(['ACK', uri, id, {}, published]);
                                    self.debug('Sending acknowledge message [%s] to socket [%s]...', message, socket.id);
                                    var send = q.nfapply(socket.send.bind(socket), [message]);

                                    send.then(function() {
                                        self.debug('Successfully respond to publish request for channel [%s] with message [%s]...', uri, message);
                                    });
                                }
                            });
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
        throw new TypeError('Server.parse accepts only a socket object an a data object as arguments!');
    }

    return this;
};

Server.prototype.loadPlugins = function(rpcDir, pubSubDir) {
    var config = this.config;
    rpcDir = rpcDir || config.getValue('plugins:rpcdir');
    pubSubDir = pubSubDir || config.getValue('plugins:pubsubdir');

    if (_.isString(rpcDir)) {
        if (fs.statSync(rpcDir).isDirectory()) {
            _.forEach(fs.readdirSync(rpcDir), function(filename) {
                var file = path.resolve(rpcDir, filename);
                if (fs.statSync(file).isFile() && filename.match(/.*\.js$/)) {
                    this.rprocs = _.merge(this.rprocs, require(file));
                } else {
                    this.warn('Cannot load RPC plugin [%s]!', file);
                }
            }, this);
        } else {
            this.error('Configured RPC plugin directory [%s] is not a directory!', rpcDir);
        }
    }

    return this;
};

Server.prototype.registerRPC = function(uri, fn) {
    if (_.isString(uri) && _.isFunction(fn)) {
        var rprocs = this.rprocs;
        if (_.isFunction(rprocs[uri])) {
            throw new Error('RPC with uri [%s] is already registered!', uri);
        } else {
            rprocs[uri] = fn;
        }
    } else {
        throw new TypeError('Server.registerRPC accepts only a string and a function as arguments!');
    }

    return this;
};

Server.prototype.unregisterRPC = function(uri) {
    if (_.isString(uri)) {
        var rprocs = this.rprocs;
        if (_.isFunction(rprocs[uri])) {
            delete rprocs[uri];
        } else {
            throw new Error('Cannot unregister RPC with uri [%s], because this function is not registered!');
        }
    } else {
        throw new TypeError('Server.unregisterRPC accepts only a string as argument!');
    }

    return this;
};

/*
Server.prototype.broadcast = function(channelname, message) {
    if (_.isString(channel) && _.isArray(message)) {
        channel = this.channels[channelname];
        if (_.isPlainObject(channel)) {
            _.forEach(channel.sockets, function(socket) {
                socket.send(message);
            });
        } else {
            this.warn('Cannot broadcast to channel [%s], because it does not exists!', channelname);
        }
    } else {
        throw new TypeError('Server.broadcast accepts only a string and an array as arguments!');
    }

    return this;
};
*/

Server.prototype.addChannel = function(channelname, opts) {
    if (_.isString(channelname)) {
        var channels = this.channels;
        if (!channels[channelname]) {
            channels[channelname] = {
                sockets: [],
                opts: opts || {}
            };
        } else {
            this.warn('A channel named [%s] already exists!', channelname);
        }
    } else {
        throw new TypeError('Server.addChannel accepts only a string as argument!');
    }

    return this;
};

Server.prototype.removeChannel = function(channelname) {
    if (_.isString(channelname)) {
        var channels = this.channels;
        if (channels[channelname]) {
            delete channels[channelname];
        } else {
            this.warn('A channel named [%s] does not exist!', channelname);
        }
    } else {
        throw new TypeError('Server.removeChannel accepts only a string as argument!');
    }

    return this;
};

Server.prototype.subscribe = function(socket, channelname) {
    if ((socket instanceof WebSocket) && _.isString(channelname)) {
        var channel = this.channels[channelname];
        if (_.isPlainObject(channel)) {
            return channel.sockets.push(socket.id);
        } else {
            this.warn('Cannot subscribe to non-existent channel [%s]!', channelname);
        }
    } else {
        throw new TypeError('Server.subscribe accepts only a socket and a string as arguments!');
    }

    return undefined;
};

Server.prototype.unsubscribe = function(socket, channelname) {
    if ((socket instanceof WebSocket) && _.isString(channelname)) {
        var channel = this.channels[channelname];
        if (_.isPlainObject(channel)) {
            channel.sockets = channel.sockets.filter(function(id) {
                return id !== socket.id;
            });

            return _.indexOf(channel.sockets, socket.id);
        } else {
            this.warn('Cannot unsubscribe from non-existing channel [%s]!', channelname);
        }
    } else {
        throw new TypeError('Server.unsubscribe accepts only a socket and a string as arguments!');
    }

    return undefined;
};

Server.prototype.publish = function(channelname, message) {
    var defer = q.defer();

    if (_.isString(channelname) && _.isArray(message)) {
        var channel = this.channels[channelname];
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
            this.warn('Cannot publish to non-existent channel [%s]!', channelname);
        }
    } else {
        throw new TypeError('Server.publish accepts only a string and an array as arguments!');
    }

    return defer.promise;
};

module.exports = Server;
