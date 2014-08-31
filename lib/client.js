var _ = require('lodash')
    , util = require('util')
    , WebSocket = require('ws')
    , q = require('q')
    , shortid = require('shortid')
    , tpl = require('node-cplate').format
    , CConf = require('node-cconf')
    , CLogger = require('node-clogger');

function Client(opts) {
    var config = new CConf('wampify-client', ['name', 'url'], {
        name: 'wampify-client'
    }).load(opts || {});

    config.setDefault('logger', new CLogger({name: config.getValue('name')}));

    config.getValue('logger').extend(this);

    WebSocket.call(this, config.getValue('url'));

    var self = this
        , socket = q.defer();
    this.on('open', function () {
        self.info('Connected to [%s]...', config.getValue('url'));
        socket.resolve(this);
    });

    this.on('error', function (err) {
        self.error('WampifyClient error:', err.message);
        socket.reject(err);
    });

    this.on('message', function (data) {
        self.debug('Incoming message...');
        self.parse(data);
    });

    this.config = config;
    this.socket = socket.promise;
    this.messages = {};
    this.channels = [];
}

util.inherits(Client, WebSocket);

Client.prototype.__defineGetter__('classname', function () { return 'Client'; });

Client.prototype.__defineGetter__('name', function () { return this.config.getValue('name'); });

Client.prototype.toString = function () {
    return tpl('{{classname}} [{{instance}}]', {classname: this.classname, instance: this.name});
};

Client.prototype.send = function (type, uri, opts) {
    var types = ['PUB', 'SUB', 'UNSUB', 'RPC']
        , args = _.toArray(arguments).slice(3)
        , defer = q.defer();

    if (_.isString(type) && _.indexOf(types, type) > -1 && _.isString(uri) && _.isPlainObject(opts)) {
        var messages = this.messages
            , id = shortid.generate()
            , data = [type, uri, id, opts].concat(args);

        this.debug('Sending message [%j]...', data);
        this.socket.then(function (self) {
            q.nfcall(Client.super_.prototype.send.bind(self), JSON.stringify(data))
            .then(function () {
                self.debug('Message [%j] sent...', data);
                if (type !== 'PUB') {
                    messages[id] = defer;
                    self.debug('Promise with id [%s] stored...', id);
                } else {
                    defer.resolve(true);
                    self.debug('Publication promise resolved...');
                }
            });
        })
        .catch(defer.reject);
    } else {
        throw new TypeError(tpl('{{instance}}.send was called with invalid arguments!', {instance: this.toString()}));
    }

    return defer.promise;
};

Client.prototype.call = function (uri, opts) {
    var args = _.toArray(arguments).slice(2);

    if (_.isString(uri) && _.isPlainObject(opts)) {
        this.debug('Call remote procedure [%s] with options [%j] and arguments [%j]...', uri, opts, args);
        return Client.prototype.send.apply(this, ['RPC', uri, opts].concat(args));
    } else {
        throw new TypeError(tpl('{{instance}}.call was called with invalid arguments!', {instance: this.toString()}));
    }
};

Client.prototype.subscribe = function (uri, opts) {
    opts = opts || {};

    if (_.isString(uri) && _.isPlainObject(opts)) {
        this.debug('Subscribe to channel [%s] with options [%j]...', uri, opts);
        return Client.prototype.send.apply(this, ['SUB', uri, opts]);
    } else {
        throw new TypeError(tpl('{{instance}}.subscribe was called with invalid arguments!', {instance: this.toString()}));
    }
};

Client.prototype.unsubscribe = function (uri, opts) {
    opts = opts || {};

    if (_.isString(uri) && _.isPlainObject(opts)) {
        this.debug('Unsubscribe from channel [%s] with options [%j]...', uri, opts);
        return Client.prototype.send.apply(this, ['UNSUB', uri, opts]);
    } else {
        throw new TypeError(tpl('{{instance}}.unsubscribe was called with invalid arguments!', {instance: this.toString()}));
    }
};

Client.prototype.publish = function (uri, opts, message) {
    if (_.isString(uri) && _.isPlainObject(opts) && message) {
        if (_.indexOf(this.channels, uri) > -1) {
            this.debug('Publish to channel [%s] with options [%j]', uri, opts);
            return Client.prototype.send.apply(this, ['PUB', uri, opts, message]);
        } else {
            this.error('Cannot publish to not-subscribed channel [%s]', uri);
        }
    } else {
        throw new TypeError(tpl('{{instance}}.publish was called with invalid arguments!', {instance: this.toString()}));
    }
};

Client.prototype.parse = function (data) {
    var message = null;

    try {
        message = JSON.parse(data);
    } catch (err) {
        this.error('Cannot parse JSON data! Reason: %s', err.message);
    }

    this.debug('Message received: %j', message);

    if (_.isArray(message)) {
        var type = message.shift()
            , uri = message.shift()
            , id = message.shift()
            , opts = message.shift()
            , args = message;

        var defer = null;
        switch (type) {
            case 'RPC':
                defer = this.messages[id];

                if (defer) {
                    defer.resolve(args);
                    this.debug('Remote procedure with id [%s] resolved...', id);
                    delete this.messages[id];
                } else {
                    this.error('Cannot resolve promise for RPC call at uri [%s]!', uri);
                }
                break;
            case 'SUB':
                defer = this.messages[id];

                if (defer) {
                    if (args[0] === true) {
                        this.channels.push(uri);
                        defer.resolve(true);
                        this.debug('Successfully subscribed to channel [%s]...', uri);
                    } else {
                        defer.reject(new Error(tpl('Cannot subscribe to channel [{{uri}}]', {uri: uri})));
                    }
                    delete this.messages[id];
                } else {
                    this.error('Cannot resolve promise for subscription at channel [%s]!', uri);
                }
                break;
            case 'UNSUB':
                defer = this.messages[id];

                if (defer) {
                    if (args[0] === true) {
                        this.channels = this.channels.filter(function (channel) {
                            return channel !== uri;
                        });
                        defer.resolve(true);
                        this.debug('Successfully unsubscribed from channel [%s]...', uri);
                    } else {
                        defer.reject(new Error(tpl('Cannot unsubscribe from channel [{{uri}}]', {uri: uri})));
                    }
                    delete this.messages[id];
                } else {
                    this.error('Cannot resolve promise for unsubscription from channel [%s]!', uri);
                }
                break;
            case 'PUB':
                if (_.indexOf(this.channels, uri) > -1) {
                    this.emit('channel', {
                        uri: uri,
                        message: args
                    });

                    this.emit('channel:' + uri, args);
                    this.debug('Successfully received publication on channel [%s]...', uri);
                } else {
                    this.error('Cannot publish to not-subscribed channel [%s]!', uri);
                }
                break;
            case 'ACK':
                defer = this.messages[id];

                if (defer) {
                    defer.resolve(args);
                    this.debug('Successfully acknowledged message on uri [%s]...', uri);
                    delete this.messages[id];
                } else {
                    this.error('Cannot resolve promise for acknowledge on uri [%s]!', uri);
                }
                break;
            case 'ERR':
                defer = this.messages[id];

                if (defer) {
                    defer.reject(args[0]);
                    this.debug('Successfully rejected promise on uri [%s]...', uri);
                    delete this.messages[id];
                } else {
                    this.error('Cannot reject promise on uri [%s]!', uri);
                }
                break;
            default:
                this.warn('Message type [%s] is not implemented yet!', type);
        }
    } else {
        this.error('Invalid message received: %j', message);
    }
};

module.exports = Client;
