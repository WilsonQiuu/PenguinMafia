async function setMemberNicknameToIgn(member, minecraftIgn) {
    if (!member || !minecraftIgn) {
        return false;
    }

    if (member.displayName === minecraftIgn || member.nickname === minecraftIgn) {
        return true;
    }

    try {
        await member.setNickname(minecraftIgn, 'Minecraft IGN linked');
        return true;
    } catch (error) {
        console.error(`Failed to set nickname for ${member.user?.tag || member.id} to ${minecraftIgn}:`);
        console.error(error);
        return false;
    }
}

module.exports = {
    setMemberNicknameToIgn
};
