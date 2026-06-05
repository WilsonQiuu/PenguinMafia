const UNITS = [
    { suffix: 't', value: 1_000_000_000_000n },
    { suffix: 'b', value: 1_000_000_000n },
    { suffix: 'm', value: 1_000_000n },
    { suffix: 'k', value: 1_000n }
];

const MULTIPLIERS = {
    k: 1_000n,
    m: 1_000_000n,
    b: 1_000_000_000n,
    t: 1_000_000_000_000n
};

function parseDonationAmount(input) {
    const rawAmount = input.trim().toLowerCase().replace(/,/g, '');
    const match = rawAmount.match(/^(\d+)(?:\.(\d+))?([kmbt])?$/);

    if (!match) {
        throw new Error('Use a positive amount like `500`, `10k`, `2.5m`, `1b`, or `1t`.');
    }

    const [, wholePart, decimalPart = '', suffix] = match;
    const scale = 10n ** BigInt(decimalPart.length);
    const multiplier = suffix ? MULTIPLIERS[suffix] : 1n;
    const rawNumber = BigInt(`${wholePart}${decimalPart}`);
    const multiplied = rawNumber * multiplier;

    if (multiplied === 0n) {
        throw new Error('Amount must be greater than 0.');
    }

    if (multiplied % scale !== 0n) {
        throw new Error('Amount must resolve to a whole donation value.');
    }

    return multiplied / scale;
}

function formatDonationAmount(value) {
    const amount = BigInt(value);

    for (const unit of UNITS) {
        if (amount >= unit.value) {
            return `${formatWithUnit(amount, unit.value)}${unit.suffix}`;
        }
    }

    return amount.toString();
}

function formatWithUnit(amount, unit) {
    const whole = amount / unit;
    const remainder = amount % unit;

    if (remainder === 0n) {
        return whole.toString();
    }

    const scaledDecimal = (remainder * 100n) / unit;

    if (scaledDecimal === 0n) {
        return whole.toString();
    }

    return `${whole}.${scaledDecimal.toString().padStart(2, '0').replace(/0+$/, '')}`;
}

function formatCents(cents) {
    const amount = BigInt(cents);
    const whole = amount / 100n;
    const decimals = amount % 100n;

    if (decimals === 0n) {
        return whole.toLocaleString('en-US');
    }

    return `${whole.toLocaleString('en-US')}.${decimals.toString().padStart(2, '0')}`;
}

module.exports = {
    formatCents,
    formatDonationAmount,
    parseDonationAmount
};
