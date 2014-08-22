var _ = require('lodash')
    , chai = require('chai')
    , expect = chai.expect
    , spies = require('chai-spies')
    , path = require('path')
    , WebSocket = require('ws')
    , clogger = require('node-clogger')
    , Server = require('../lib/server');

chai.use(spies);

var logger = new clogger.CLogger('tests');

describe('WebsocketServer', function() {
    it('should instanciates', function(done) {
        this.timeout(2000);

        var server = new Server({port: 3000});
        expect(server).to.be.an.instanceof(Server);

        setTimeout(function() {
            server.close();
            done();
        }, 1000);
    });
});

describe('WebSocketServer:RPC', function() {
    this.timeout(3000);

    var server = null;

    beforeEach(function() {
        server = new Server({
            port: 3000,
            plugins: {
                rpcdir: path.resolve(process.cwd(), 'lib/rprocs')
            }
        });
    });

    afterEach(function(done) {
        server.close();
        setTimeout(function() {
            done();
        }, 2000);
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

describe('WebSocketServer:PUB/SUB', function() {
    this.timeout(3000);

    var server = null;

    beforeEach(function() {
        server = new Server({port: 3000});
    });

    afterEach(function(done) {
        server.close();
        setTimeout(function() {
            done();
        }, 2000);
    });

    it('should add a new channel', function() {
        server = server.addChannel('test:echo', {ack: true});
        expect(server).to.be.an.instanceof(Server);
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
        expect(server).to.be.an.instanceof(Server);
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

        var ws = new WebSocket('ws://localhost:3000');

        function onopen() {
            ws.send(JSON.stringify(['SUB', 'test:$inge', 4327, {ack: true}]));

            setTimeout(function() {
                ws.send(JSON.stringify(['PUB', 'test:$inge', 2743, {ack: true}, 'hello $inge']));
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
            } else if (data[0] === 'PUB') {
                logger.debug('Call 2');
                expect(data).to.be.deep.equal(['PUB', 'test:$inge', 2743, {}, 'hello $inge']);
            } else if (data[0] === 'ACK' && data[2] === 2743) {
                logger.debug('Call 3');
                expect(data).to.be.deep.equal(['ACK', 'test:$inge', 2743, {}, true]);
            } else {
                done(new Error('Invalid response!'));
            }
        }

        var spyA = chai.spy(onopen)
            , spyB = chai.spy(onmessage);
        ws.on('open', spyA);
        ws.on('message', spyB);

        setTimeout(function() {
            expect(spyA).to.have.been.called.once;
            expect(spyB).to.have.been.called.exactly(3);
            ws.close();
            done();
        }, 2000);
    });
});
