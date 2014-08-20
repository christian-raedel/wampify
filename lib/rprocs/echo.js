var _ = require('lodash');

function Echo(message) {
    return [message];
}

module.exports['test:echo'] = Echo;
