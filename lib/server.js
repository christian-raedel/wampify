var _ = require('lodash')
    , util = require('util')
    , fs = require('fs')
    , path = require('path')
    , q = require('q')
    , WebSocketServer = require('ws').Server
    , WebSocket = require('ws')
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

    this.on('close', function() {
        self.info('Server closed');
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
        if (_.indexOf(this.sockets, socket) === -1) {
            var self = this;

            socket.on('message', function(data) {
                self.parse(socket, data);
            });

            socket.on('error', function(err) {
                self.error('Socket error: %s', err.message);
            });

            socket.on('close', function(code, reason) {
                self.info('Socket closed: %s %s', code, reason);
                self.removeSocket(socket);
            });

            this.info('Socket opened');
            this.sockets.push(socket);
        }
    } else {
        throw new TypeError('Server.addSocket accepts only a socket object as argument!');
    }

    return this;
};

Server.prototype.removeSocket = function(socket) {
    if (socket instanceof WebSocket) {
        this.sockets = this.sockets.filter(function(ws) {
            return ws !== socket;
        });
    } else {
        throw new TypeError('Server.removeSocket accepts only a socket object as argument!');
    }

    return this;
};

Server.prototype.parse = function(socket, data) {
    if ((socket instanceof WebSocket) && data) {
        var message = null;
        try {
            message = JSON.parse(data);
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
                            var published = self.publish(uri, message) ? true : false;
                            if (self.channels[uri].opts.ack && opts.ack) {
                                message = JSON.stringify(['ACK', uri, id, {}, published]);
                                socket.send(message, function(err) {
                                    if (err) {
                                        throw err;
                                    } else {
                                        self.debug('Successfully respond to publish request for channel [%s] with message [%s]...', uri, message);
                                    }
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
            return channel.sockets.push(socket);
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
            channel.sockets = channel.sockets.filter(function(ws) {
                return ws !== socket;
            });

            return _.indexOf(channel.sockets, socket);
        } else {
            this.warn('Cannot unsubscribe from non-existing channel [%s]!', channelname);
        }
    } else {
        throw new TypeError('Server.unsubscribe accepts only a socket and a string as arguments!');
    }

    return undefined;
};

Server.prototype.publish = function(channelname, message) {
    if (_.isString(channelname) && _.isArray(message)) {
        var channel = this.channels[channelname];
        if (_.isPlainObject(channel)) {
            message = JSON.stringify(message);

            var count = 0;
            _.forEach(channel.sockets, function(socket) {
                var self = this;

                socket.send(message, function(err) {
                    if (err) {
                        throw new Error('Cannot publish message to socket! Reason: ' + err.message);
                    } else {
                        count += 1;
                    }
                });
            }, this);

            this.info('Message [%s] was published to [%d] sockets...', message, count);
            return count === channel.sockets.length;
        } else {
            this.warn('Cannot publish to non-existent channel [%s]!', channelname);
        }
    } else {
        throw new TypeError('Server.publish accepts only a string and an array as arguments!');
    }

    return undefined;
};

module.exports = Server;
