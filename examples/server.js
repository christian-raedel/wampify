var _ = require('lodash')
    , CLogger = require('node-clogger')
    , Wampify = require('../index');

var server = new Wampify({
    port: 3000,
    logger: new CLogger({ name: 'websocket-server', visible: ['info', 'warn', 'error']})
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
