var _ = require('lodash')
    , chai = require('chai')
    , expect = chai.expect
    , spies = require('chai-spies')
    , path = require('path')
    , WebSocket = require('ws')
    , CLogger = require('node-clogger')
    , Wampify = require('../index');

chai.use(spies);

var logger = new CLogger('tests');

describe('Wampify', function() {
    it('should instanciates', function(done) {
        this.timeout(2000);

        var server = new Wampify({port: 3000});
        expect(server).to.be.an.instanceof(Wampify);

        setTimeout(function() {
            server.close();
            done();
        }, 500);
    });
});

describe('Wampify:RPC', function() {
    this.timeout(3000);

    var server = null;

    beforeEach(function() {
        server = new Wampify({
            port: 3000,
            plugins: path.resolve(process.cwd(), 'lib/rprocs')
        });
    });

    afterEach(function(done) {
        server.close();
        setTimeout(function() {
            done();
        }, 500);
    });

    it('should load plugins', function() {
        server.loadPlugins();
        expect(server.rprocs['tests:echo']).to.be.a.function;
    });

    it('should register new RPC functions', function() {
        server.registerRPC('tests:echo', function(message) { return [message]; });
        expect(server.rprocs['tests:echo']).to.be.a.function;
    });

    it('should unregister a RPC function', function() {
        server.registerRPC('tests:echo', function() {}).unregisterRPC('tests:echo');
        expect(server.rprocs['tests:echo']).to.be.not.a.function;
    });

    it('should execute a RPC function', function(done) {
        server.loadPlugins();

        var ws = new WebSocket('ws://localhost:3000')
            , message = ['RPC', 'test:echo', 4327, {}, 'hello $inge!'];
        ws.on('open', function() {
            ws.send(JSON.stringify(message));
        });
        ws.on('message', function(data) {
            try {
                data = JSON.parse(data);
            } catch (err) {
                done(err);
            }
            expect(data).to.be.deep.equal(message);
            ws.close();
            done();
        });
    });
});

describe('Wampify:PUB/SUB', function() {
    this.timeout(3000);

    var server = null;

    beforeEach(function() {
        server = new Wampify({port: 3000});
    });

    afterEach(function(done) {
        server.close();
        setTimeout(function() {
            done();
        }, 500);
    });

    it('should add a new channel', function() {
        server = server.addChannel('test:echo', {ack: true});
        expect(server).to.be.an.instanceof(Wampify);
        expect(server.channels).to.be.deep.equal({
            'test:echo': {
                sockets: [],
                opts: {
                    ack: true
                }
            }
        });
    });

    it('should remove an existing channel', function() {
        server = server.addChannel('test:echo').removeChannel('test:echo');
        expect(server).to.be.an.instanceof(Wampify);
        expect(server.channels).to.be.deep.equal({});
    });

    it('should subscribe to an existing channel', function(done) {
        server.addChannel('test:$inge', {ack: true});

        var ws = new WebSocket('ws://localhost:3000')
            , message = ['SUB', 'test:$inge', 2743, {ack: true}];
        ws.on('open', function() {
            ws.send(JSON.stringify(message));
        });
        ws.on('message', function(data) {
            try {
                data = JSON.parse(data);
            } catch(err) {
                done(err);
            }
            expect(data).to.be.deep.equal(['ACK', 'test:$inge', 2743, {}, true]);
            ws.close();
            done();
        });
    });

    it('should publish to an existing channel', function(done) {
        this.timeout(10000);

        server.addChannel('test:$inge', {ack: true});
        expect(server.channels['test:$inge']).to.be.ok;

        var uri = 'ws://localhost:3000'
            , ws = new WebSocket(uri)
            , ws2 = new WebSocket(uri)
            , i = 2743;

        function onopen() {
            ws.send(JSON.stringify(['SUB', 'test:$inge', 4327, {ack: true}]));

            setTimeout(function() {
                ws.send(JSON.stringify(['PUB', 'test:$inge', i++, {ack: true}, 'hello $inge']));
            }, 500);
        }

        function onmessage(data) {
            try {
                data = JSON.parse(data);
            } catch (err) {
                done(err);
            }

            logger.info('Received socket data: %j', data);
            if (data[0] === 'ACK' && data[2] === 4327) {
                logger.debug('Call 1');
                expect(data).to.be.deep.equal(['ACK', 'test:$inge', 4327, {}, true]);
            } else if (data[0] === 'PUB' && data[2] === 2743) {
                logger.debug('Call 2.1');
                expect(data).to.be.deep.equal(['PUB', 'test:$inge', 2743, {}, 'hello $inge']);
            } else if (data[0] === 'PUB' && data[2] === 2744) {
                logger.debug('Call 2.2');
                expect(data).to.be.deep.equal(['PUB', 'test:$inge', 2744, {}, 'hello $inge']);
            } else if (data[0] === 'ACK' && data[2] === 2743) {
                logger.debug('Call 3.1');
                expect(data).to.be.deep.equal(['ACK', 'test:$inge', 2743, {}, true]);
            } else if (data[0] === 'ACK' && data[2] === 2744) {
                logger.debug('Call 3.2');
                expect(data).to.be.deep.equal(['ACK', 'test:$inge', 2744, {}, true]);
            } else {
                done(new Error('Invalid response!'));
            }
        }

        var spyA = chai.spy(onopen)
            , spyB = chai.spy(onmessage);
        ws.on('open', spyA);
        ws.on('message', spyB);
        ws2.on('open', spyA);
        ws2.on('message', spyB);

        setTimeout(function() {
            expect(spyA).to.have.been.called.twice;
            expect(spyB).to.have.been.called.exactly(6);
            ws.close();
            ws2.close();
            done();
        }, 1000);
    });
});

describe('Wampify:Use', function() {
    this.timeout(3000);

    var server = null;

    beforeEach(function() {
        server = new Wampify({port: 3000});
    });

    afterEach(function(done) {
        server.close();
        setTimeout(function() {
            done();
        }, 500);
    });

    it('should use middleware', function(done) {
        server.registerRPC('echo', function(args) { return [args]; }).use(function(socket, message) {
            logger.debug('Middleware 1');
            message[2]++;
            return message;
        }).use(function(socket, message, next) {
            logger.debug('Middleware 2');
            message[3].setByMiddleWare = true;
            return message;
        });

        server.on('error', function(err) {
            done(err);
        });

        ws = new WebSocket('ws://localhost:3000');
        ws.on('open', function() {
            var message = ['RPC', 'echo', 1, {}, 2];
            ws.send(JSON.stringify(message));
        });

        ws.on('message', function(data) {
            var message = JSON.parse(data);
            expect(message[2]).to.be.equal(2);
            expect(message[3].setByMiddleWare).to.be.true;
            ws.close();
            setTimeout(function() {
                done();
            }, 500);
        });
    });
});
