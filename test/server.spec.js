var _ = require('lodash')
    , expect = require('chai').expect
    , path = require('path')
    , WebSocket = require('ws')
    , Server = require('../lib/server');

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
            , message = ['RPC', 'test:echo', 4327, 'hello $inge!'];
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
            done();
        });
    });
});
