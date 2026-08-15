const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    formatVoiceTime,
    voiceProgress
} = require('../utils/voiceLeveling.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vchours')
        .setDescription('Check tracked voice-call hours and VC level.')
        .addUserOption(option =>
            option
                .setName('player')
                .setDescription('The player to check')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        const requestedUser = interaction.options.getUser('player') || interaction.user;

        try {
            const rows = await sql`
                select voice_minutes::text, voice_xp::text
                from vc_levels
                where guild_id = ${interaction.guild.id}
                    and discord_id = ${requestedUser.id}
                limit 1
            `;
            const voiceMinutes = Number(rows[0]?.voice_minutes || 0);
            const voiceXp = Number(rows[0]?.voice_xp || 0);
            const progress = voiceProgress(voiceXp);
            const decimalHours = (voiceMinutes / 60).toFixed(2);

            await interaction.editReply(
                `🎙️🐧 **VC Time & Level**\n\n` +
                `Player: ${requestedUser}\n` +
                `Tracked call time: **${formatVoiceTime(voiceMinutes)}** (**${decimalHours} hours**)\n` +
                `VC level: **${progress.level}**\n` +
                `Total VC XP: **${voiceXp}**\n` +
                `Level progress: **${progress.earnedThisLevel}/${progress.neededThisLevel} VC XP**\n` +
                `Next level in: **${progress.xpToNextLevel} VC XP** ` +
                `(**${formatVoiceTime(progress.xpToNextLevel * 10)}**)\n\n` +
                `Time is credited in 10-minute segments while you are connected to voice chat.`
            );
        } catch (error) {
            logCommandError(interaction, '/vchours', error);

            await interaction.editReply(
                `❌ **VC hours command failed.**\n\n` +
                `Error:\n\`\`\`\n${error.message}\n\`\`\``
            );
        }
    }
};
