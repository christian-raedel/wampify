var CLogger = require('node-clogger')
    , WampifyClient = require('../index').Client;

var client = new WampifyClient({
    name: 'wampify-test-client',
    url: 'ws://localhost:3000',
    logger: new CLogger({name: 'client', visible: ['info', 'warn', 'error']})
});

client.call('example:add', {}, 43, -1).then(function (sum) {
    client.info('The Meaning of Life? %d!', sum[0]);
}).catch(function (reason) {
    client.error('An error occured: %s', reason);
    process.exit(1);
});

client.subscribe('example:$inge').then(function (subscribed) {
    client.info('subscription state = %s', subscribed ? 'subscribed' : 'rejected');

    client.on('channel:example:$inge', function (args) {
        client.info('message received: %s', args[0]);
    });

    client.publish('example:$inge', {}, 'hello $inge!').then(function (published) {
        client.info('publication state = %s', published ? 'published' : 'rejected');

        client.unsubscribe('example:$inge').then(function (unsubscribed) {
            client.info('unsubscription state = %s', unsubscribed ? 'unsubscribed' : 'rejected');
            process.exit(0);
        });
    });
}).catch(function (reason) {
    client.error('An error occured: %s', reason);
    process.exit(2);
});
