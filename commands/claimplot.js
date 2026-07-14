const {
    SlashCommandBuilder
} = require('discord.js');

const {
    handleClaimPlot
} = require('./iceberg.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('claimplot')
        .setDescription('Claim an Iceberg plot.')
        .addIntegerOption(opt =>
            opt.setName('number').setDescription('Plot number').setRequired(true).setMinValue(1)
        ),

    async execute(interaction) {
        return handleClaimPlot(interaction, '/claimplot');
    }
};
