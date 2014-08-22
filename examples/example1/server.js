var _ = require('lodash')
    , clogger = require('node-clogger')
    , Wampify = require('../lib/wampify');

var server = new Wampify({
    port: 3000,
    logger: new clogger.CLogger('websocket-server', {visible: ['info', 'warn', 'error']})
})
.registerRPC('example:add', function() {
    var args = _.toArray(arguments);

    var sum = _.reduce(args, function(a, b) {
        return a + b;
    });

    this.info('Sum %j = %j...', args, sum);
    return [sum];
})
.addChannel('example:global')
.addChannel('example:$inge', {ack: true});
