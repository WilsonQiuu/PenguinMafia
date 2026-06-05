const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies with Pong! and latency information'),

    async execute(interaction) {
        await interaction.reply({
            content: 'Pinging...'
        });

        const sent = await interaction.fetchReply();

        const pingTime = sent.createdTimestamp - interaction.createdTimestamp;

        await interaction.editReply(
            `Pong! 🏓\n` +
            `Bot Latency: ${pingTime}ms\n` +
            `API Latency: ${Math.round(interaction.client.ws.ping)}ms`
        );
    },
};