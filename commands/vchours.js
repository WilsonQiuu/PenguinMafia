const {
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const sql = require('../db.js');
const {
    logCommandError
} = require('../utils/logging.js');
const {
    VOICE_CREDIT_SECONDS,
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
                select (
                    stats.voice_seconds + coalesce(
                        greatest(0, floor(extract(epoch from (now() - session.started_at))))::bigint,
                        0
                    )
                )::text as voice_seconds
                from vc_levels stats
                left join vc_active_sessions session
                    on session.guild_id = stats.guild_id
                    and session.discord_id = stats.discord_id
                where stats.guild_id = ${interaction.guild.id}
                    and stats.discord_id = ${requestedUser.id}
                limit 1
            `;
            const voiceSeconds = Number(rows[0]?.voice_seconds || 0);
            const voiceXp = Math.floor(voiceSeconds / VOICE_CREDIT_SECONDS);
            const progress = voiceProgress(voiceXp);
            const decimalHours = (voiceSeconds / 3600).toFixed(2);

            await interaction.editReply(
                `🎙️🐧 **VC Time & Level**\n\n` +
                `Player: ${requestedUser}\n` +
                `Tracked call time: **${formatVoiceTime(voiceSeconds)}** (**${decimalHours} hours**)\n` +
                `VC level: **${progress.level}**\n` +
                `Total VC XP: **${voiceXp}**\n` +
                `Level progress: **${progress.earnedThisLevel}/${progress.neededThisLevel} VC XP**\n` +
                `Next level in: **${progress.xpToNextLevel} VC XP** ` +
                `(**${formatVoiceTime(progress.xpToNextLevel * VOICE_CREDIT_SECONDS)}**)\n\n` +
                `VC time is tracked to the second from Discord join, leave, move, and AFK events.`
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
