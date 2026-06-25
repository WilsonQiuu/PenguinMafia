const EASTERN_TIME_ZONE = 'America/Toronto';

const easternHourFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
});

const easternTimeZoneNameFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    timeZoneName: 'short'
});

function easternTimeZoneName(date) {
    return easternTimeZoneNameFormatter
        .formatToParts(date)
        .find(part => part.type === 'timeZoneName')?.value || 'ET';
}

function formatEasternHourRange(start) {
    const startDate = new Date(start);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

    return `${easternHourFormatter.format(startDate)}–${easternHourFormatter.format(endDate)} ${easternTimeZoneName(startDate)}`;
}

module.exports = {
    EASTERN_TIME_ZONE,
    formatEasternHourRange
};
