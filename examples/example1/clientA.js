var WebSocket = require('ws');

var ws = new WebSocket('ws://localhost:3000');

ws.on('open', function() {
    var rpcCall = JSON.stringify(['RPC', 'example:add', 123, {}, 1, 2, 3, 4, 5, 6, 7]);
    ws.send(rpcCall);

    var subscription = JSON.stringify(['SUB', 'example:$inge', 124, {ack: true}]);
    ws.send(subscription);

    subscription = JSON.stringify(['SUB', 'example:global', 127, {}]);
    ws.send(subscription);

    var i = 0;
    var intervalId = setInterval(function() {
        var message = JSON.stringify(['PUB', 'example:$inge', i++, {}, 'Hello world!']);
        ws.send(message);

        if (i > 27) {
            var unsubscription = JSON.stringify(['UNSUB', 'example:$inge', 125, {ack: true}]);
            ws.send(unsubscription);
            clearInterval(intervalId);
        }
    }, 500);
});

ws.on('message', function(data) {
    var message = [];

    try {
        message = JSON.parse(data);
    } catch (err) {
        console.log(err);
        process.exit(1);
    }

    var type = message.shift()
        , uri = message.shift()
        , id = message.shift()
        , opts = message.shift()
        , args = message;

    if (type === 'RPC' && uri === 'example:add') {
        console.log('sum = %d', args[0]);
    } else if (type === 'PUB') {
        console.log('channel #%d>\t%s', id, args[0]);
    } else if (type === 'ACK' && id === 125) {
        console.log('finished!');
        process.exit(0);
    }
});
