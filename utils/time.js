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

function validDateOrFallback(value, fallback = new Date()) {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
        return date;
    }

    const fallbackDate = new Date(fallback);

    if (!Number.isNaN(fallbackDate.getTime())) {
        return fallbackDate;
    }

    return new Date();
}

function formatEasternHourRange(start, fallback = new Date()) {
    const startDate = validDateOrFallback(start, fallback);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

    return `${easternHourFormatter.format(startDate)}–${easternHourFormatter.format(endDate)} ${easternTimeZoneName(startDate)}`;
}

module.exports = {
    EASTERN_TIME_ZONE,
    formatEasternHourRange
};
