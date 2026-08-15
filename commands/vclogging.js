const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    isDon
} = require('../utils/staff.js');
const {
    setVoiceXpModLogging,
    voiceXpModLoggingEnabled
} = require('../utils/voiceLeveling.js');

function statusMessage(enabled) {
    return enabled
        ? '🧪 VC XP development logging is **ON**. Every 10-minute scan will show all credited players in mod logs.'
        : '🧪 VC XP development logging is **OFF**. Normal VC tracking and level-up messages are still active.';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vclogging')
        .setDescription('Turn VC XP development logs on or off. Owner only.')
        .addStringOption(option =>
            option
                .setName('action')
                .setDescription('Enable, disable, or check VC XP mod logging')
                .setRequired(true)
                .addChoices(
                    { name: 'Enable', value: 'enable' },
                    { name: 'Disable', value: 'disable' },
                    { name: 'Status', value: 'status' }
                )
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        if (!isDon(interaction.user.id)) {
            await interaction.editReply('❌ Only the owner can use `/vclogging`.');
            return;
        }

        const action = interaction.options.getString('action');

        try {
            const enabled = action === 'status'
                ? await voiceXpModLoggingEnabled(interaction.guild.id, sql)
                : await setVoiceXpModLogging(interaction.guild.id, action === 'enable', sql);

            await interaction.editReply(statusMessage(enabled));
        } catch (error) {
            logCommandError(interaction, '/vclogging', error);

            await interaction.editReply(
                `❌ **VC logging command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
