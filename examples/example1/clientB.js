var WebSocket = require('ws');

var ws = new WebSocket('ws://localhost:3000');

ws.on('open', function() {
    var subscription = JSON.stringify(['SUB', 'example:global', 0, {ack: true}]);
    ws.send(subscription);

    setTimeout(function() {
        for(var i = 1; i < 100; i++) {
            var message = JSON.stringify(['PUB', 'example:global', i + 1, {ack: true}, 'Hello $inge!']);
            ws.send(message);
        }

        ws.close();
    }, 14000);
});
