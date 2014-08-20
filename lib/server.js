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

    var config = new CConf(opts.name).load(opts);

    this.config = config;
    this.sockets = [];
    this.rprocs = {};
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
                self.info('Socket closed: %s; %s', code, reason);
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
                , args = message;

            switch (type) {
                case 'RPC':
                    q.fcall(function() {
                        message = self.rprocs[uri].apply(self, args);
                        if (_.isArray(message)) {
                            message = [type, uri, id].concat(message);
                        } else if (_.isPlainObject(message)) {
                            message = [type, uri, id, message];
                        } else {
                            throw new TypeError('RPCs must return a plain object or an argument array!');
                        }

                        return message;
                    }).then(function(message) {
                        socket.send(JSON.stringify(message));
                    }).catch(function(err) {
                        self.error('Unable to call RPC [%s]! Reason: %s', uri, err.message);
                    });
                    break;
                default:
                    this.warn('Not implemented yet!');
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

module.exports = Server;
