var _ = require('lodash')
    , chai = require('chai')
    , expect = chai.expect
    , spies = require('chai-spies')
    , path = require('path')
    , WebSocket = require('ws')
    , Server = require('../lib/server');

chai.use(spies);

describe('WebsocketServer', function() {
    it('should instanciates', function(done) {
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

    before(function() {
        server = new Server({port: 3000});
    });

    after(function(done) {
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
        server = server.removeChannel('test:echo');
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
        expect(server.channels['test:$inge']).to.be.ok;

        var ws = new WebSocket('ws://localhost:3000');

        var spyB = null;
        function onopen() {
            function onmessage(data) {
                try {
                    data = JSON.parse(data);
                } catch (err) {
                    done(err);
                }

                console.log(data);
                switch (data[0]) {
                    case 'PUB':
                        expect(data).to.be.deep.equal(['PUB', 'test:$inge', 2743, {}, 'hello $inge']);
                        break;
                    case 'ACK':
                        expect(data).to.be.deep.equal(['ACK', 'test:$inge', 2743, {}, true]);
                        break;
                    default:
                        done(new Error('Invalid message response!'));
                }
            }
            spyB = chai.spy(onmessage);
            ws.on('message', spyB);

            ws.send(JSON.stringify(['PUB', 'test:$inge', 2743, {}, 'hello $inge']));
        }

        var spyA = chai.spy(onopen);
        ws.on('open', spyA);

        setTimeout(function() {
            expect(spyA).to.have.been.called.once;
            expect(spyB).to.have.been.called.twice;
            ws.close();
            done();
        }, 2000);
    });
});
