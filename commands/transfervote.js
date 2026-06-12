const {
    buildCommand,
    executeTransferVotes
} = require('./transfervotes.js');

module.exports = {
    data: buildCommand('transfervote'),
    execute: executeTransferVotes
};
