var _ = require('lodash')
    , chai = require('chai')
    , expect = chai.expect
    , spies = require('chai-spies')
    , promised = require('chai-as-promised')
    , CLogger = require('node-clogger')
    , Wampify = require('../index')
    , Client = require('../index').Client;

chai.use(spies).use(promised);

var logger = new CLogger({name: 'tests'});

describe('Client:Constructor', function () {
    var server = null;

    beforeEach(function (done) {
        server = new Wampify({
            name: 'wampify-test-server',
            port: 3000
        });
        setTimeout(function () { done(); }, 500);
    });

    afterEach(function (done) {
        server.close();
        setTimeout(function () { done(); }, 500);
    });

    it('should instanciate', function () {
        expect(new Client({url: 'ws://localhost:3000'})).to.be.an.instanceof(Client);
    });

    it('should throw an error, if no url is given', function () {
        try {
            new Client();
        } catch (err) {
            expect(err).to.be.an.instanceof(Error);
            expect(err.message).to.match(/url/);
        }
    });
});

describe('Client:RPC', function () {
    var server = null;

    beforeEach(function (done) {
        server = new Wampify({
            name: 'wampify-test-server',
            port: 3000
        });
        setTimeout(function () { done(); }, 500);
    });

    afterEach(function (done) {
        server.close();
        setTimeout(function () { done(); }, 500);
    });

    it('should call a remote procedure', function (done) {
        server.registerRPC('echo', function (args) { return [args]; });

        var client = new Client({url: 'ws://localhost:3000'});
        client.call('echo', {}, 43).then(function (args) {
            expect(args).to.be.deep.equal([43]);
            done();
        });
    });

    it('should receive an error message on RPC fail', function (done) {
        server.registerRPC('error', function (args) { throw new Error(args); });

        var client = new Client({url: 'ws://localhost:3000'});
        client.call('error', {}, 'hello $inge!')
        .catch(function (reason) {
            expect(reason).to.be.equal('hello $inge!');
            done();
        });
    });
});

describe('Client:PUB/SUB', function () {
    var server = null, client = null;

    before(function (done) {
        server = new Wampify({
            name: 'wampify-test-server',
            port: 3000
        });
        setTimeout(function () {
            client = new Client({
                name: 'wampify-test-client',
                url: 'ws://localhost:3000'
            });
            done();
        }, 500);
    });

    after(function (done) {
        client.close();
        server.close();
        setTimeout(function () { done(); }, 500);
    });

    it('should subscribe to a channel', function (done) {
        server.addChannel('$inge');

        client.subscribe('$inge').then(function (subscribed) {
            expect(subscribed).to.be.true;
            done();
        });
    });

    it('should publish to channel', function (done) {
        function onchannel(args) {
            logger.info('onChannel');
            expect(args).to.be.deep.equal({
                uri: '$inge',
                message: ['dlc']
            });
        }

        function onspecificchannel(args) {
            logger.info('onSpecificChannel');
            expect(args).to.be.deep.equal(['dlc']);
        }

        var spyA = chai.spy(onchannel)
            , spyB = chai.spy(onspecificchannel);
        client.on('channel', spyA);
        client.on('channel:$inge', spyB);

        client.publish('$inge', {}, 'dlc').then(function (sent) {
            setTimeout(function () {
                logger.info('onAfterSent');
                expect(sent).to.be.true;
                expect(spyA).to.have.been.called.once;
                expect(spyB).to.have.been.called.once;
                done();
            }, 500);
        }).catch(done);
    });

    it('should unsubscribe from channel', function (done) {
        client.unsubscribe('$inge').then(function (unsubscribed) {
            expect(unsubscribed).to.be.true;
            done();
        });
    });
});
